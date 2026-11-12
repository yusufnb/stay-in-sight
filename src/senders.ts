import type { MailboxRow } from './google';
import { checkFromEmail, getMailbox } from './service';
import { Env, HttpError, isEmail, normEmail, now } from './util';
import { purposeOf } from './purpose';

export interface SenderRow {
  id: number;
  mailbox_id: number;
  key: string;
  label: string;
  description: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  is_default: number;
  created_at: number;
  updated_at: number;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sender';

export function publicSender(s: SenderRow, mb?: MailboxRow, stats?: { sent: number; opened: number; replied: number; scheduled: number }) {
  return {
    id: s.id,
    key: s.key,
    label: s.label,
    description: s.description,
    mailbox_id: s.mailbox_id,
    ...(mb ? { mailbox: mb.email, provider: mb.provider || 'google', purpose: purposeOf(mb) } : {}),
    from_name: s.from_name,
    from_email: s.from_email || mb?.email || null,
    reply_to: s.reply_to,
    is_default: !!s.is_default,
    ...(stats ? { stats } : {}),
    created_at: iso(s.created_at),
    updated_at: iso(s.updated_at),
  };
}

/** A sender by numeric id or key. */
export async function getSenderRow(env: Env, ref: string | number): Promise<SenderRow> {
  const byId = typeof ref === 'number' || /^\d+$/.test(String(ref));
  const s = byId
    ? await env.DB.prepare('SELECT * FROM senders WHERE id = ?').bind(Number(ref)).first<SenderRow>()
    : await env.DB.prepare('SELECT * FROM senders WHERE key = ?').bind(String(ref).trim().toLowerCase()).first<SenderRow>();
  if (!s) throw new HttpError(404, `Sender not found: ${ref}`);
  return s;
}

export async function defaultSender(env: Env, mailboxId: number): Promise<SenderRow | null> {
  return env.DB.prepare('SELECT * FROM senders WHERE mailbox_id = ? ORDER BY is_default DESC, id LIMIT 1').bind(mailboxId).first<SenderRow>();
}

export async function listSenders(env: Env, f: { mailbox?: string | number } = {}) {
  let where = '';
  const vals: unknown[] = [];
  if (f.mailbox !== undefined && f.mailbox !== '') {
    const mb = await getMailbox(env, f.mailbox);
    where = 'WHERE s.mailbox_id = ?';
    vals.push(mb.id);
  }
  const [rows, mbs] = await Promise.all([
    env.DB.prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM emails e WHERE e.sender_id = s.id AND e.status IN ('sent','bounced')) AS sent,
         (SELECT COUNT(*) FROM emails e WHERE e.sender_id = s.id AND e.status = 'scheduled') AS scheduled,
         (SELECT COUNT(*) FROM emails e WHERE e.sender_id = s.id AND e.open_count > 0) AS opened,
         (SELECT COUNT(*) FROM emails e WHERE e.sender_id = s.id AND e.reply_count > 0) AS replied
       FROM senders s ${where} ORDER BY s.mailbox_id, s.is_default DESC, s.label COLLATE NOCASE`,
    )
      .bind(...vals)
      .all<SenderRow & { sent: number; scheduled: number; opened: number; replied: number }>(),
    env.DB.prepare('SELECT * FROM mailboxes').all<MailboxRow>(),
  ]);
  const byId = new Map(mbs.results.map((m) => [m.id, m]));
  return rows.results.map((s) => publicSender(s, byId.get(s.mailbox_id), { sent: s.sent, scheduled: s.scheduled, opened: s.opened, replied: s.replied }));
}

export async function getSender(env: Env, ref: string | number) {
  const s = await getSenderRow(env, ref);
  return (await listSenders(env, { mailbox: s.mailbox_id })).find((x) => x.id === s.id)!;
}

export interface SenderInput {
  mailbox?: string | number;
  key?: string;
  label?: string;
  description?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  reply_to?: string | null;
  is_default?: boolean;
}

async function cleanIdentity(env: Env, mb: MailboxRow, d: SenderInput, current?: SenderRow) {
  const out: Partial<SenderRow> = {};
  if (d.label !== undefined) {
    const label = String(d.label ?? '').trim();
    if (!label || label.length > 80) throw new HttpError(400, 'label must be 1-80 characters');
    out.label = label;
  }
  if (d.description !== undefined) {
    const desc = String(d.description ?? '').trim();
    if (desc.length > 1000) throw new HttpError(400, 'description must be 1000 characters or fewer');
    out.description = desc || null;
  }
  if (d.from_name !== undefined) out.from_name = String(d.from_name ?? '').trim().slice(0, 120) || null;
  if (d.from_email !== undefined) {
    const f = normEmail(d.from_email);
    if (f && f !== mb.email) await checkFromEmail(env, mb, f);
    out.from_email = f && f !== mb.email ? f : null;
  }
  if (d.reply_to !== undefined) {
    const r = normEmail(d.reply_to);
    if (r && !isEmail(r)) throw new HttpError(400, 'reply_to must be an email address');
    out.reply_to = r || null;
  }
  if (d.key !== undefined && d.key !== current?.key) {
    const key = String(d.key ?? '').trim().toLowerCase();
    if (!KEY_RE.test(key)) throw new HttpError(400, 'key must be 1-48 characters: lowercase letters, numbers and "-"');
    const taken = await env.DB.prepare('SELECT id FROM senders WHERE key = ?').bind(key).first<{ id: number }>();
    if (taken && taken.id !== current?.id) throw new HttpError(409, `Sender key "${key}" is already used`);
    out.key = key;
  }
  return out;
}

async function uniqueKey(env: Env, base: string) {
  let key = slugify(base);
  for (let i = 2; await env.DB.prepare('SELECT 1 FROM senders WHERE key = ?').bind(key).first(); i++) key = `${slugify(base).slice(0, 40)}-${i}`;
  return key;
}

/** Create a sender on a mailbox. The first sender of a mailbox is its default. */
export async function createSender(env: Env, d: SenderInput) {
  if (d.mailbox === undefined || d.mailbox === '') throw new HttpError(400, 'mailbox is required');
  const mb = await getMailbox(env, d.mailbox);
  if (!String(d.label ?? '').trim()) throw new HttpError(400, 'label is required');
  const clean = await cleanIdentity(env, mb, { ...d, key: d.key || undefined });
  const key = clean.key || (await uniqueKey(env, String(d.label)));
  const hasDefault = !!(await env.DB.prepare('SELECT 1 FROM senders WHERE mailbox_id = ? AND is_default = 1').bind(mb.id).first());
  const makeDefault = !hasDefault || !!d.is_default;
  const t = now();
  const stmts = [
    ...(makeDefault ? [env.DB.prepare('UPDATE senders SET is_default = 0 WHERE mailbox_id = ?').bind(mb.id)] : []),
    env.DB.prepare(
      'INSERT INTO senders (mailbox_id, key, label, description, from_name, from_email, reply_to, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(mb.id, key, clean.label!, clean.description ?? null, clean.from_name ?? null, clean.from_email ?? null, clean.reply_to ?? null, makeDefault ? 1 : 0, t, t),
  ];
  await env.DB.batch(stmts);
  return getSender(env, key);
}

export async function updateSender(env: Env, ref: string | number, d: SenderInput) {
  const s = await getSenderRow(env, ref);
  const mb = await getMailbox(env, s.mailbox_id);
  if (d.mailbox !== undefined && (await getMailbox(env, d.mailbox)).id !== mb.id) throw new HttpError(400, "A sender can't move to another mailbox; create a new one there");
  const clean = await cleanIdentity(env, mb, d, s);
  const sets = Object.keys(clean).map((k) => `${k} = ?`);
  const vals = Object.values(clean);
  const stmts: D1PreparedStatement[] = [];
  if (d.is_default === true && !s.is_default) {
    stmts.push(env.DB.prepare('UPDATE senders SET is_default = 0 WHERE mailbox_id = ?').bind(mb.id));
    sets.push('is_default = 1');
  }
  if (d.is_default === false && s.is_default) throw new HttpError(400, 'Make another sender the default instead');
  if (sets.length) stmts.push(env.DB.prepare(`UPDATE senders SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`).bind(...vals, now(), s.id));
  if (stmts.length) await env.DB.batch(stmts);
  return getSender(env, s.id);
}

/** Emails already scheduled keep their From/Reply-To; they just lose the link to this sender. */
export async function deleteSender(env: Env, ref: string | number) {
  const s = await getSenderRow(env, ref);
  if (s.is_default) throw new HttpError(400, "The default sender can't be deleted. Make another sender the default first.");
  await env.DB.prepare('DELETE FROM senders WHERE id = ?').bind(s.id).run();
  return { deleted: s.key };
}
