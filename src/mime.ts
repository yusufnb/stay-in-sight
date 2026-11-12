import { b64urlEncodeStr, escapeHtml, randomToken } from './util';

const enc = new TextEncoder();

function b64Utf8(s: string): string {
  const bytes = enc.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Wrap base64 to 76-char lines as required by RFC 2045. */
function wrap76(s: string): string {
  return s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/** RFC 2047 encoded-word for non-ASCII header values. */
export function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${b64Utf8(v)}?=`;
}

export function formatAddress(email: string, name?: string | null): string {
  if (!name) return email;
  // eslint-disable-next-line no-control-regex
  const n = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeHeader(name);
  return `${n} <${email}>`;
}

export function textToHtml(text: string): string {
  return `<div>${escapeHtml(text).replace(/\r?\n/g, '<br>\n')}</div>`;
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
        const l = label.replace(/<[^>]+>/g, '').trim();
        return l && l !== href ? `${l} (${href})` : href;
      })
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

export function injectPixel(html: string, pixelUrl: string): string {
  const img = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${img}</body>`) : html + img;
}

export interface MimeInput {
  from: string; // formatted address
  to: string; // formatted address
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

/** RFC 5322 multipart/alternative message (ASCII: headers RFC 2047-encoded, bodies base64). */
export function buildMimeText(m: MimeInput): string {
  const boundary = `b_${randomToken(12)}`;
  const headers: Record<string, string> = {
    From: m.from,
    To: m.to,
    Subject: encodeHeader(m.subject),
    'MIME-Version': '1.0',
    ...m.headers,
    'Content-Type': `multipart/alternative; boundary="${boundary}"`,
  };
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64Utf8(m.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64Utf8(m.html)),
    `--${boundary}--`,
    '',
  ];
  return [...lines, '', ...body].join('\r\n');
}

/** Same message, base64url-encoded for Gmail's `raw`. */
export function buildMime(m: MimeInput): string {
  return b64urlEncodeStr(buildMimeText(m));
}
