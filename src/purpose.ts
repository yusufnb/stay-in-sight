import type { MailboxRow } from './google';

/** What a mailbox is for. Decides how its mail is built and which opt-outs block it. */
export type Purpose = 'outreach' | 'newsletter' | 'conversation';
export const PURPOSE_KEYS: Purpose[] = ['outreach', 'newsletter', 'conversation'];

/** Which purposes a do-not-send entry blocks. */
export type DncScope = 'all' | 'marketing' | 'newsletter';
export const DNC_SCOPES: DncScope[] = ['all', 'marketing', 'newsletter'];
const SCOPE_RANK: Record<DncScope, number> = { newsletter: 1, marketing: 2, all: 3 };

export interface PurposeDefaults {
  label: string;
  description: string;
  track_opens: boolean;
  list_unsubscribe: boolean;
  footer: string;
  /** List-Id and Precedence: bulk. */
  bulk_headers: boolean;
  /** Random extra spacing between auto-planned sends, as a fraction of the throttle. */
  jitter: number;
  suggested: { daily_limit: number; throttle_minutes: number };
}

export const PURPOSES: Record<Purpose, PurposeDefaults> = {
  outreach: {
    label: 'Cold outreach',
    description: 'One-to-one emails to people who have not heard from you. Built to look like a personal email: no tracking pixel, no unsubscribe header, a "reply stop" line instead, and uneven spacing between sends.',
    track_opens: false,
    list_unsubscribe: false,
    footer: 'If you\'d rather not hear from me, just reply "stop".',
    bulk_headers: false,
    jitter: 0.6,
    suggested: { daily_limit: 30, throttle_minutes: 8 },
  },
  newsletter: {
    label: 'Newsletter',
    description: 'Bulk mail to people who signed up. Open tracking, one-click unsubscribe (required by Gmail and Yahoo for bulk senders), a visible unsubscribe link and list headers.',
    track_opens: true,
    list_unsubscribe: true,
    footer: "You're receiving this because you signed up for updates.\nUnsubscribe: {{unsubscribe_url}}",
    bulk_headers: true,
    jitter: 0,
    suggested: { daily_limit: 1000, throttle_minutes: 1 },
  },
  conversation: {
    label: 'Conversation',
    description: 'Back-and-forth with people who write to you or expect a reply, by a person or an agent. Plain mail with no tracking, replies land in the same thread, and only hard opt-outs (bounces, complaints, explicit stop) block it.',
    track_opens: false,
    list_unsubscribe: false,
    footer: '',
    bulk_headers: false,
    jitter: 0,
    suggested: { daily_limit: 200, throttle_minutes: 1 },
  },
};

export const DNC_SCOPE_LABELS: Record<DncScope, string> = {
  all: 'Everything',
  marketing: 'Outreach and newsletters',
  newsletter: 'Newsletters only',
};

export function purposeOf(mb: Pick<MailboxRow, 'purpose'>): Purpose {
  return PURPOSE_KEYS.includes(mb.purpose as Purpose) ? (mb.purpose as Purpose) : 'outreach';
}

/** How this mailbox builds mail: the purpose defaults with the mailbox's own overrides applied. */
export function mailFormat(mb: Pick<MailboxRow, 'purpose' | 'track_opens' | 'list_unsubscribe' | 'footer'>) {
  const p = PURPOSES[purposeOf(mb)];
  return {
    purpose: purposeOf(mb),
    track_opens: mb.track_opens === null || mb.track_opens === undefined ? p.track_opens : !!mb.track_opens,
    list_unsubscribe: mb.list_unsubscribe === null || mb.list_unsubscribe === undefined ? p.list_unsubscribe : !!mb.list_unsubscribe,
    footer: mb.footer === null || mb.footer === undefined ? p.footer : mb.footer,
    bulk_headers: p.bulk_headers,
    jitter: p.jitter,
  };
}

/** Does a do-not-send entry with this scope block mail from a mailbox with this purpose? */
export function scopeBlocks(scope: string | null | undefined, purpose: Purpose | null): boolean {
  const s = (DNC_SCOPES.includes(scope as DncScope) ? scope : 'all') as DncScope;
  if (s === 'all' || purpose === null) return true;
  if (s === 'marketing') return purpose !== 'conversation';
  return purpose === 'newsletter';
}

/** The purposes an entry with this scope blocks (for SQL filters). */
export function blockedPurposes(scope: DncScope): Purpose[] {
  return PURPOSE_KEYS.filter((p) => scopeBlocks(scope, p));
}

/** The scope of an opt-out (STOP reply or unsubscribe) that came from a mailbox with this purpose. */
export function optOutScope(purpose: Purpose): DncScope {
  return purpose === 'newsletter' ? 'newsletter' : purpose === 'outreach' ? 'marketing' : 'all';
}

export const wider = (a: DncScope, b: DncScope): DncScope => (SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b);
export const scopeRankSql = (col: string) => `CASE ${col} WHEN 'all' THEN 3 WHEN 'marketing' THEN 2 ELSE 1 END`;

export function checkScope(v: unknown): DncScope {
  const s = String(v ?? 'all').trim().toLowerCase();
  if (!DNC_SCOPES.includes(s as DncScope)) throw new Error(`scope must be one of: ${DNC_SCOPES.join(', ')}`);
  return s as DncScope;
}

export function checkPurpose(v: unknown): Purpose {
  const s = String(v ?? '').trim().toLowerCase();
  if (!PURPOSE_KEYS.includes(s as Purpose)) throw new Error(`purpose must be one of: ${PURPOSE_KEYS.join(', ')}`);
  return s as Purpose;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The footer (plain text, may use {{unsubscribe_url}}) for the text and HTML parts. */
export function renderFooter(footer: string, unsubscribeUrl: string): { text: string; html: string } | null {
  const text = footer.trim().replace(/\{\{\s*unsubscribe_url\s*\}\}/g, unsubscribeUrl);
  if (!text) return null;
  const html = escHtml(text)
    .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:inherit">${u === escHtml(unsubscribeUrl) ? 'Unsubscribe' : u}</a>`)
    .replace(/Unsubscribe: (<a [^>]+>Unsubscribe<\/a>)/, '$1')
    .replace(/\n/g, '<br>');
  return { text, html: `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280">${html}</p>` };
}

/** Seeded pseudo-random numbers in [0, 1), so a plan preview matches what gets scheduled. */
export function seededRandom(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
