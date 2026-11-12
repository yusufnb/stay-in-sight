import type { GmailMessage, GmailPart } from './google';
import { htmlToText } from './mime';

export function header(msg: GmailMessage | GmailPart | undefined, name: string): string {
  const part = msg && 'payload' in msg ? msg.payload : (msg as GmailPart | undefined);
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

export function parseAddress(v: string): { name: string | null; email: string } {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: v.trim().toLowerCase() };
}

function decodePartData(data: string, contentType: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const charset = (contentType.match(/charset="?([^";\s]+)"?/i)?.[1] || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Collect the first text/plain and text/html bodies (ignores attachments). */
export function extractBodies(payload: GmailPart | undefined): { text: string; html: string } {
  const out = { text: '', html: '' };
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.filename) return; // attachment
    const ct = header(p, 'content-type') || p.mimeType;
    if (p.body?.data) {
      if (p.mimeType === 'text/plain' && !out.text) out.text = decodePartData(p.body.data, ct);
      else if (p.mimeType === 'text/html' && !out.html) out.html = decodePartData(p.body.data, ct);
    }
    p.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}

/** Remove the quoted conversation from an HTML reply (Gmail/Outlook/Apple Mail markers), keeping the new content. */
export function stripQuotedHtml(html: string): string {
  const markers = [
    /<div[^>]+class="?[^">]*gmail_quote/i,
    /<div[^>]+id="?appendonsend/i,
    /<div[^>]+id="?divRplyFwdMsg/i,
    /<hr[^>]+id="?stopSpelling/i,
    /<blockquote[^>]+type="?cite/i,
    /<div[^>]+class="?[^">]*yahoo_quoted/i,
  ];
  let cut = html.length;
  for (const re of markers) {
    const m = re.exec(html);
    if (m && m.index < cut) cut = m.index;
  }
  return html.slice(0, cut).replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
}

const QUOTE_HEADERS: RegExp[] = [
  /^\s*On\b[\s\S]{0,400}?\bwrote:\s*$/im, // Gmail / Apple: "On Tue, ... <x@y> wrote:" (may wrap lines)
  /^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/im,
  /^\s*_{10,}\s*$/m, // Outlook separator line
  /^\s*From:\s.+\n\s*(Sent|Date):\s/im, // Outlook header block
  /^\s*Le\b[\s\S]{0,300}?a écrit\s*:\s*$/im,
  /^\s*Am\b[\s\S]{0,300}?schrieb\b[\s\S]{0,100}?:\s*$/im,
  /^\s*El\b[\s\S]{0,300}?escribió:\s*$/im,
];

/** Remove quoted history and trailing boilerplate from a plain-text reply. */
export function stripQuotedText(text: string): string {
  let t = text.replace(/\r\n/g, '\n');
  let cut = t.length;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  t = t
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
  t = t.replace(/\n\s*Sent from my [^\n]+\s*$/i, '').replace(/\n\s*Get Outlook for [^\n]+\s*$/i, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Full body text and the "new" content of a message with quoted history removed. */
export function messageText(msg: GmailMessage): { full: string; latest: string } {
  const { text, html } = extractBodies(msg.payload);
  return bodiesText(text, html, msg.snippet || '');
}

/** Full text and the new part (quoted history removed) from a text and/or HTML body. */
export function bodiesText(text: string, html: string, fallback = ''): { full: string; latest: string } {
  const full = text || (html ? htmlToText(html) : fallback);
  let latest = text ? stripQuotedText(text) : '';
  if (!latest && html) latest = stripQuotedText(htmlToText(stripQuotedHtml(html)));
  if (!latest) latest = stripQuotedText(full);
  return { full: full.trim(), latest };
}

export function isStop(latest: string, subject = ''): boolean {
  const firstLine = latest.split('\n').find((l) => l.trim())?.trim() || '';
  const cleaned = firstLine.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (/^(stop|unsubscribe|remove me|opt out|optout)\b/i.test(cleaned) && cleaned.split(/\s+/).length <= 6) return true;
  if (!latest.trim() && /^\s*(stop|unsubscribe)\s*$/i.test(subject)) return true;
  return false;
}

export type ReplyKind = 'reply' | 'auto' | 'bounce';

export function classify(msg: GmailMessage): ReplyKind {
  return classifyHeaders((n) => header(msg, n), `${msg.payload?.mimeType || ''} ${header(msg, 'content-type')}`, header(msg, 'from'));
}

/** Reply, auto-reply or bounce, from the message headers (works for any source). */
export function classifyHeaders(get: (name: string) => string, contentType: string, fromRaw: string): ReplyKind {
  const from = fromRaw.toLowerCase();
  const ct = contentType;
  if (/mailer-daemon|postmaster@/.test(from) || /multipart\/report|delivery-status/i.test(ct)) return 'bounce';
  const autoSubmitted = get('auto-submitted').toLowerCase();
  const precedence = get('precedence').toLowerCase();
  const subject = get('subject');
  if (
    (autoSubmitted && autoSubmitted !== 'no') ||
    get('x-autoreply') ||
    get('x-autorespond') ||
    /^(auto_reply|bulk|junk|list)$/.test(precedence) ||
    /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|abwesenheit|réponse automatique)/i.test(subject)
  ) {
    return 'auto';
  }
  return 'reply';
}
