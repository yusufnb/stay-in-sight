import type { MailboxRow } from './google';
import { purposeOf } from './purpose';
import { getGroupRow, getMailbox, GroupRow, isConnected } from './service';
import { Env, HttpError, now } from './util';
import { dailyLimitAt, warmupInfo } from './warmup';

const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);

function publicGroup(g: GroupRow, members: MailboxRow[], sent: Map<number, number>) {
  const t = now();
  const sending = members.filter((m) => m.active && isConnected(m));
  const purposes = [...new Set(members.map((m) => purposeOf(m)))];
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    purpose: purposes.length === 1 ? purposes[0] : purposes.length ? 'mixed' : null,
    mailboxes: members.map((m) => ({
      id: m.id,
      email: m.email,
      purpose: purposeOf(m),
      provider: m.provider || 'google',
      sending: !!m.active && isConnected(m),
      daily_limit: m.daily_limit,
      today_limit: dailyLimitAt(m, t),
      throttle_minutes: m.throttle_minutes,
      warmup: warmupInfo(m, t),
      sent_24h: sent.get(m.id) ?? 0,
    })),
    /** Emails the group can send in the next 24 hours, across mailboxes that are sending. */
    capacity_today: sending.reduce((n, m) => n + dailyLimitAt(m, t), 0),
    sent_24h: members.reduce((n, m) => n + (sent.get(m.id) ?? 0), 0),
    created_at: iso(g.created_at),
    updated_at: iso(g.updated_at),
  };
}

async function sentLast24h(env: Env) {
  const r = await env.DB.prepare("SELECT mailbox_id, COUNT(*) AS n FROM emails WHERE sent_at >= ? AND status IN ('sent','bounced') GROUP BY mailbox_id")
    .bind(now() - 86_400_000)
    .all<{ mailbox_id: number; n: number }>();
  return new Map(r.results.map((x) => [x.mailbox_id, x.n]));
}

export async function listGroups(env: Env) {
  const [groups, mbs, sent] = await Promise.all([
    env.DB.prepare('SELECT * FROM mailbox_groups ORDER BY name COLLATE NOCASE').all<GroupRow>(),
    env.DB.prepare('SELECT * FROM mailboxes WHERE group_id IS NOT NULL ORDER BY id').all<MailboxRow>(),
    sentLast24h(env),
  ]);
  return groups.results.map((g) => publicGroup(g, mbs.results.filter((m) => m.group_id === g.id), sent));
}

export async function getGroup(env: Env, ref: string | number) {
  const g = await getGroupRow(env, ref);
  const [mbs, sent] = await Promise.all([env.DB.prepare('SELECT * FROM mailboxes WHERE group_id = ? ORDER BY id').bind(g.id).all<MailboxRow>(), sentLast24h(env)]);
  return publicGroup(g, mbs.results, sent);
}

export interface GroupInput {
  name?: string;
  description?: string | null;
  /** Mailbox emails or ids. Replaces the membership; a mailbox in another group moves here. */
  mailboxes?: (string | number)[];
}

function cleanName(v: unknown) {
  const name = String(v ?? '').trim();
  if (!name || name.length > 60) throw new HttpError(400, 'name must be 1-60 characters');
  if (/^\d+$/.test(name)) throw new HttpError(400, "name can't be only digits (ids are numbers)");
  return name;
}

async function setMembers(env: Env, groupId: number, refs: (string | number)[]) {
  if (!Array.isArray(refs)) throw new HttpError(400, 'mailboxes must be a list of mailbox emails or ids');
  const ids = [...new Set(await Promise.all(refs.map(async (r) => (await getMailbox(env, r)).id)))];
  await env.DB.batch([
    env.DB.prepare(`UPDATE mailboxes SET group_id = NULL WHERE group_id = ?${ids.length ? ` AND id NOT IN (${ids.map(() => '?').join(',')})` : ''}`).bind(groupId, ...ids),
    ...ids.map((id) => env.DB.prepare('UPDATE mailboxes SET group_id = ? WHERE id = ?').bind(groupId, id)),
  ]);
}

export async function createGroup(env: Env, d: GroupInput) {
  const name = cleanName(d.name);
  if (await env.DB.prepare('SELECT 1 FROM mailbox_groups WHERE name = ?').bind(name).first()) throw new HttpError(409, `A group named "${name}" already exists`);
  const t = now();
  const r = await env.DB.prepare('INSERT INTO mailbox_groups (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(name, String(d.description ?? '').trim() || null, t, t)
    .run();
  const id = Number(r.meta.last_row_id);
  if (d.mailboxes) await setMembers(env, id, d.mailboxes);
  return getGroup(env, id);
}

export async function updateGroup(env: Env, ref: string | number, d: GroupInput) {
  const g = await getGroupRow(env, ref);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.name !== undefined) {
    const name = cleanName(d.name);
    const other = await env.DB.prepare('SELECT id FROM mailbox_groups WHERE name = ?').bind(name).first<{ id: number }>();
    if (other && other.id !== g.id) throw new HttpError(409, `A group named "${name}" already exists`);
    sets.push('name = ?');
    vals.push(name);
  }
  if (d.description !== undefined) (sets.push('description = ?'), vals.push(String(d.description ?? '').trim() || null));
  if (sets.length) await env.DB.prepare(`UPDATE mailbox_groups SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now(), g.id).run();
  if (d.mailboxes !== undefined) await setMembers(env, g.id, d.mailboxes);
  return getGroup(env, g.id);
}

/** The mailboxes leave the group; emails already scheduled through it keep their mailbox. */
export async function deleteGroup(env: Env, ref: string | number) {
  const g = await getGroupRow(env, ref);
  await env.DB.batch([
    env.DB.prepare('UPDATE mailboxes SET group_id = NULL WHERE group_id = ?').bind(g.id),
    env.DB.prepare('DELETE FROM mailbox_groups WHERE id = ?').bind(g.id),
  ]);
  return { deleted: g.name };
}
