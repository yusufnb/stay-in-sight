import { gmailApi, MailboxRow } from './google';
import { htmlToText } from './mime';
import { checkLimit, LIMITS, planSlots } from './planner';
import { SES_REGIONS, SesCreds, sesCheck } from './ses';
import { getTemplateRow, missingValues, normTemplateId, normVars, renderTemplate, templateRecipients, TemplateRow } from './templates';
import { header, messageText, parseAddress } from './parse';
import { dailyLimitAt, warmupInfo, WARMUP_LIMITS } from './warmup';
import { blockedPurposes, checkPurpose, checkScope, DncScope, mailFormat, Purpose, purposeOf, scopeBlocks, scopeRankSql, seededRandom } from './purpose';
import { Env, HttpError, isEmail, normEmail, now, parseTime, randomToken } from './util';

export interface EmailRow {
  id: number;
  mailbox_id: number;
  campaign: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  sender_id: number | null;
  to_email: string;
  to_name: string | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  send_at: number;
  status: string;
  status_reason: string | null;
  attempts: number;
  track_token: string;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  ses_message_id: string | null;
  message_id_header: string | null;
  sent_at: number | null;
  open_count: number;
  first_opened_at: number | null;
  last_opened_at: number | null;
  reply_count: number;
  last_reply_at: number | null;
  metadata: string | null;
  template_id: string | null;
  parent_email_id: number | null;
  group_id: number | null;
  series_id: number | null;
  series_step_id: number | null;
  ai_status: string | null;
  ai_note: string | null;
  ai_model: string | null;
  ai_cost: number | null;
  personalized_at: number | null;
  created_at: number;
}

export interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

/** A mailbox group by numeric id or name. */
export async function getGroupRow(env: Env, ref: string | number): Promise<GroupRow> {
  const byId = typeof ref === 'number' || /^\d+$/.test(String(ref).trim());
  const g = byId
    ? await env.DB.prepare('SELECT * FROM mailbox_groups WHERE id = ?').bind(Number(ref)).first<GroupRow>()
    : await env.DB.prepare('SELECT * FROM mailbox_groups WHERE name = ?').bind(String(ref).trim()).first<GroupRow>();
  if (!g) throw new HttpError(404, `Group not found: ${ref}`);
  return g;
}

const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);

// ---------- Mailboxes ----------

/** Can this mailbox send? Gmail needs a refresh token; SES needs access keys. */
export const isConnected = (m: MailboxRow) => (m.provider === 'ses' ? !!(m.ses_access_key_id && m.ses_secret_access_key) : !!m.refresh_token);

const sesStatus = (m: MailboxRow) => {
  try {
    return m.ses_status ? (JSON.parse(m.ses_status) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Addresses a mailbox may send as: itself first, then verified Gmail aliases. */
export function sendAsList(m: MailboxRow): { email: string; name: string | null }[] {
  let aliases: { email: string; name: string | null }[] = [];
  try {
    aliases = m.send_as ? JSON.parse(m.send_as) : [];
  } catch {
    /* ignore */
  }
  const out = [{ email: m.email, name: m.name }];
  for (const a of aliases) if (a.email !== m.email) out.push(a);
  return out;
}

/** Load the mailbox's verified "Send mail as" addresses from Gmail and store them. */
export async function refreshSendAs(env: Env, mb: MailboxRow) {
  if (mb.provider === 'ses') return sendAsList(mb);
  const r = await gmailApi.sendAs(env, mb);
  const list = (r.sendAs || [])
    .filter((a) => a.isPrimary || a.verificationStatus === 'accepted')
    .map((a) => ({ email: a.sendAsEmail.toLowerCase(), name: a.displayName || null }));
  await env.DB.prepare('UPDATE mailboxes SET send_as = ? WHERE id = ?').bind(JSON.stringify(list), mb.id).run();
  mb.send_as = JSON.stringify(list);
  return sendAsList(mb);
}

/** Throws unless `from` is the mailbox or one of its verified aliases (re-checking Gmail once if unsure). */
export async function checkFromEmail(env: Env, mb: MailboxRow, from: string) {
  if (mb.provider === 'ses') {
    // A verified SES domain can send as any address on it; a verified address only as itself.
    const verified = String(sesStatus(mb)?.verified_identity || '');
    if (from === mb.email || (verified && !verified.includes('@') && from.endsWith(`@${verified}`))) return;
    throw new HttpError(400, `${from} isn't covered by this SES mailbox's verified identity (${verified || mb.email}). Verify the domain in SES to send as any address on it.`);
  }
  const ok = () => sendAsList(mb).some((a) => a.email === from);
  if (ok()) return;
  try {
    await refreshSendAs(env, mb);
  } catch {
    /* Gmail unreachable: fall through to the error below */
  }
  if (!ok()) {
    throw new HttpError(
      400,
      `${from} isn't a verified "Send mail as" address of ${mb.email}. Add it in Gmail (Settings → Accounts → Send mail as), then refresh the mailbox's addresses.`,
    );
  }
}

/** Purpose, how its mail is built (effective), and which of those are the mailbox's own overrides. */
function mailboxFormat(m: MailboxRow) {
  const { purpose, track_opens, list_unsubscribe, footer, bulk_headers } = mailFormat(m);
  return {
    purpose,
    format: { track_opens, list_unsubscribe, footer, bulk_headers },
    format_overrides: {
      track_opens: m.track_opens === null || m.track_opens === undefined ? null : !!m.track_opens,
      list_unsubscribe: m.list_unsubscribe === null || m.list_unsubscribe === undefined ? null : !!m.list_unsubscribe,
      footer: m.footer ?? null,
    },
  };
}

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
};

export function publicMailbox(m: MailboxRow) {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    webhook_url: m.webhook_url,
    has_webhook_secret: !!m.webhook_secret,
    daily_limit: m.daily_limit,
    today_limit: dailyLimitAt(m, now()),
    throttle_minutes: m.throttle_minutes,
    warmup: warmupInfo(m),
    group_id: m.group_id ?? null,
    from_email: m.from_email || m.email,
    reply_to: m.reply_to,
    send_as: sendAsList(m),
    active: !!m.active,
    connected: isConnected(m),
    provider: m.provider || 'google',
    ...mailboxFormat(m),
    ...(m.provider === 'ses'
      ? {
          ses: {
            region: m.ses_region,
            access_key_id: m.ses_access_key_id ? `…${m.ses_access_key_id.slice(-4)}` : null,
            has_secret: !!m.ses_secret_access_key,
            configuration_set: m.ses_configuration_set,
            status: sesStatus(m),
          },
          reply_domain: m.reply_domain,
          forward_to: m.forward_to,
        }
      : {}),
    push_watch_expires_at: iso(m.watch_expires_at),
    last_sync_at: iso(m.last_sync_at),
    last_error: m.last_error,
    created_at: iso(m.created_at),
  };
}

/** Mailboxes for the UI/API, with how many emails each sent in the last 24h. */
export async function listMailboxes(env: Env) {
  const [rows, sent, senders, groups] = await Promise.all([
    listMailboxRows(env),
    env.DB.prepare("SELECT mailbox_id, COUNT(*) AS n FROM emails WHERE sent_at >= ? AND status IN ('sent','bounced') GROUP BY mailbox_id")
      .bind(now() - 86_400_000)
      .all<{ mailbox_id: number; n: number }>(),
    env.DB.prepare('SELECT id, mailbox_id, key, label, description, from_name, from_email, reply_to, is_default FROM senders ORDER BY is_default DESC, label COLLATE NOCASE').all<SenderLite>(),
    env.DB.prepare('SELECT id, name FROM mailbox_groups').all<{ id: number; name: string }>(),
  ]);
  const m = new Map(sent.results.map((r) => [r.mailbox_id, r.n]));
  const gname = new Map(groups.results.map((g) => [g.id, g.name]));
  return rows.map((r) => ({
    ...publicMailbox(r),
    group: r.group_id ? { id: r.group_id, name: gname.get(r.group_id) ?? null } : null,
    sent_24h: m.get(r.id) ?? 0,
    senders: senders.results
      .filter((s) => s.mailbox_id === r.id)
      .map((s) => ({ id: s.id, key: s.key, label: s.label, description: s.description, from_name: s.from_name, from_email: s.from_email || r.email, reply_to: s.reply_to, is_default: !!s.is_default })),
  }));
}

interface SenderLite {
  id: number;
  mailbox_id: number;
  key: string;
  label: string;
  description: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  is_default: number;
}

/** Every mailbox has a default sender; create one from its From settings if missing. */
export async function ensureDefaultSender(env: Env, mb: MailboxRow) {
  if (await env.DB.prepare('SELECT 1 FROM senders WHERE mailbox_id = ?').bind(mb.id).first()) return;
  const base = mb.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'sender';
  let key = base;
  for (let i = 2; await env.DB.prepare('SELECT 1 FROM senders WHERE key = ?').bind(key).first(); i++) key = `${base}-${i}`;
  await env.DB.prepare(
    'INSERT INTO senders (mailbox_id, key, label, description, from_name, from_email, reply_to, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  )
    .bind(mb.id, key, mb.name || mb.email, `Default sender for ${mb.email}`, mb.name, mb.from_email, mb.reply_to, now(), now())
    .run();
}

/** A sender by id or key, with its mailbox. */
async function senderRef(env: Env, ref: string | number): Promise<SenderLite> {
  const byId = typeof ref === 'number' || /^\d+$/.test(String(ref));
  const s = await env.DB.prepare(`SELECT * FROM senders WHERE ${byId ? 'id' : 'key'} = ?`).bind(byId ? Number(ref) : String(ref).trim().toLowerCase()).first<SenderLite>();
  if (!s) throw new HttpError(404, `Sender not found: ${ref}`);
  return s;
}

export async function listMailboxRows(env: Env): Promise<MailboxRow[]> {
  return (await env.DB.prepare('SELECT * FROM mailboxes ORDER BY id').all<MailboxRow>()).results;
}

export async function getMailbox(env: Env, ref: string | number): Promise<MailboxRow> {
  const r =
    typeof ref === 'number' || /^\d+$/.test(String(ref))
      ? await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(Number(ref)).first<MailboxRow>()
      : await env.DB.prepare('SELECT * FROM mailboxes WHERE email = ?').bind(normEmail(String(ref))).first<MailboxRow>();
  if (!r) throw new HttpError(404, `Mailbox not found: ${ref}`);
  return r;
}

export async function upsertMailbox(env: Env, d: { email: string; name: string | null; refresh_token: string; access_token: string; expires_in: number }) {
  await env.DB.prepare(
    `INSERT INTO mailboxes (email, name, refresh_token, access_token, token_expires_at, daily_limit, throttle_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
       token_expires_at = excluded.token_expires_at, active = 1, last_error = NULL`,
  )
    .bind(d.email, d.name, d.refresh_token, d.access_token, now() + d.expires_in * 1000, LIMITS.DEFAULT_DAILY_LIMIT, LIMITS.DEFAULT_THROTTLE_MINUTES, now())
    .run();
  const mb = await getMailbox(env, d.email);
  await ensureDefaultSender(env, mb);
  return mb;
}

export async function updateMailbox(
  env: Env,
  ref: string | number,
  patch: {
    name?: string | null;
    webhook_url?: string | null;
    webhook_secret?: string | null;
    daily_limit?: number;
    throttle_minutes?: number;
    active?: boolean;
    from_email?: string | null;
    reply_to?: string | null;
    reply_domain?: string | null;
    forward_to?: string | null;
    ses_region?: string;
    ses_access_key_id?: string;
    ses_secret_access_key?: string;
    ses_configuration_set?: string | null;
    purpose?: string;
    track_opens?: boolean | null;
    list_unsubscribe?: boolean | null;
    footer?: string | null;
    /** Warm-up on/off. Turning it on starts day 1 now. */
    warmup?: boolean;
    warmup_start?: number;
    warmup_step?: number;
    /** Start the warm-up again from day 1. */
    warmup_restart?: boolean;
    /** Group id or name; null or "" removes it from its group. */
    group?: string | number | null;
  },
) {
  const mb = await getMailbox(env, ref);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) (sets.push('name = ?'), vals.push(patch.name || null));
  if (patch.webhook_url !== undefined) {
    if (patch.webhook_url && !/^https?:\/\//.test(patch.webhook_url)) throw new HttpError(400, 'webhook_url must be http(s)');
    sets.push('webhook_url = ?');
    vals.push(patch.webhook_url || null);
  }
  if (patch.webhook_secret !== undefined) (sets.push('webhook_secret = ?'), vals.push(patch.webhook_secret || null));
  try {
    if (patch.daily_limit !== undefined) {
      sets.push('daily_limit = ?');
      vals.push(checkLimit('daily_limit', patch.daily_limit, 1, LIMITS.MAX_DAILY_LIMIT));
    }
    if (patch.throttle_minutes !== undefined) {
      sets.push('throttle_minutes = ?');
      vals.push(checkLimit('throttle_minutes', patch.throttle_minutes, 1, LIMITS.MAX_THROTTLE_MINUTES));
    }
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  if (patch.active !== undefined) (sets.push('active = ?'), vals.push(patch.active ? 1 : 0));
  if (patch.purpose !== undefined) (sets.push('purpose = ?'), vals.push(asHttp(() => checkPurpose(patch.purpose))));
  for (const k of ['track_opens', 'list_unsubscribe'] as const) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(patch[k] === null ? null : patch[k] ? 1 : 0);
  }
  if (patch.warmup_start !== undefined) (sets.push('warmup_start = ?'), vals.push(asHttp(() => checkLimit('warmup_start', patch.warmup_start, WARMUP_LIMITS.MIN_START, WARMUP_LIMITS.MAX_START))));
  if (patch.warmup_step !== undefined) (sets.push('warmup_step = ?'), vals.push(asHttp(() => checkLimit('warmup_step', patch.warmup_step, WARMUP_LIMITS.MIN_STEP, WARMUP_LIMITS.MAX_STEP))));
  if (patch.warmup === false) sets.push('warmup_enabled = 0', 'warmup_started_at = NULL');
  else if ((patch.warmup === true && !mb.warmup_enabled) || (patch.warmup_restart && (patch.warmup === true || mb.warmup_enabled))) {
    sets.push('warmup_enabled = 1', 'warmup_started_at = ?');
    vals.push(now());
  }
  if (patch.group !== undefined) {
    sets.push('group_id = ?');
    vals.push(patch.group === null || patch.group === '' ? null : (await getGroupRow(env, patch.group)).id);
  }
  if (patch.footer !== undefined) {
    const f = patch.footer === null ? null : String(patch.footer).replace(/\r\n/g, '\n').trim();
    if (f && f.length > 1000) throw new HttpError(400, 'footer must be 1000 characters or fewer');
    sets.push('footer = ?');
    vals.push(f);
  }
  if (patch.from_email !== undefined) {
    const f = normEmail(patch.from_email);
    if (f && f !== mb.email) await checkFromEmail(env, mb, f);
    sets.push('from_email = ?');
    vals.push(f && f !== mb.email ? f : null);
  }
  if (patch.reply_to !== undefined) {
    const r = normEmail(patch.reply_to);
    if (r && !isEmail(r)) throw new HttpError(400, 'reply_to must be an email address');
    sets.push('reply_to = ?');
    vals.push(r || null);
  }
  if (mb.provider === 'ses') {
    if (patch.reply_domain !== undefined) (sets.push('reply_domain = ?'), vals.push(checkDomain(patch.reply_domain)));
    if (patch.forward_to !== undefined) {
      const f = normEmail(patch.forward_to);
      if (f && !isEmail(f)) throw new HttpError(400, 'forward_to must be an email address');
      sets.push('forward_to = ?');
      vals.push(f || null);
    }
    if (patch.ses_configuration_set !== undefined) (sets.push('ses_configuration_set = ?'), vals.push(String(patch.ses_configuration_set || '').trim() || null));
    const creds = {
      region: patch.ses_region ?? mb.ses_region ?? '',
      accessKeyId: patch.ses_access_key_id?.trim() || mb.ses_access_key_id || '',
      secretAccessKey: patch.ses_secret_access_key?.trim() || mb.ses_secret_access_key || '',
    };
    if (patch.ses_region !== undefined || patch.ses_access_key_id || patch.ses_secret_access_key) {
      if (!SES_REGIONS.includes(creds.region)) throw new HttpError(400, `Unknown SES region: ${creds.region}`);
      const status = await sesCheckOrThrow(creds, mb.email);
      sets.push('ses_region = ?', 'ses_access_key_id = ?', 'ses_secret_access_key = ?', 'ses_status = ?', 'last_error = NULL');
      vals.push(creds.region, creds.accessKeyId, creds.secretAccessKey, JSON.stringify(status));
    }
  }
  if (sets.length) await env.DB.prepare(`UPDATE mailboxes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, mb.id).run();
  return publicMailbox(await getMailbox(env, mb.id));
}

function checkDomain(v: unknown): string | null {
  const d = String(v ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!d) return null;
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw new HttpError(400, `Not a valid domain: ${d}`);
  return d;
}

async function sesCheckOrThrow(creds: SesCreds, fromEmail: string) {
  try {
    const status = await sesCheck(creds, fromEmail);
    if (!status.verified_identity) throw new HttpError(400, `Neither ${fromEmail} nor its domain is a verified identity in SES ${creds.region}. Verify it in the SES console first.`);
    return status;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `Couldn't use these SES credentials: ${(err as Error).message}`);
  }
}

/** Add an AWS SES mailbox. Checks the keys and that the From address (or its domain) is verified. */
export async function createSesMailbox(
  env: Env,
  d: { email: string; name?: string; region: string; access_key_id: string; secret_access_key: string; configuration_set?: string; reply_domain: string; forward_to?: string; purpose?: string },
) {
  const email = normEmail(d.email);
  if (!isEmail(email)) throw new HttpError(400, 'email must be the From address to send as');
  if (!SES_REGIONS.includes(d.region)) throw new HttpError(400, `Unknown SES region: ${d.region}`);
  if (!d.access_key_id?.trim() || !d.secret_access_key?.trim()) throw new HttpError(400, 'access_key_id and secret_access_key are required');
  const replyDomain = checkDomain(d.reply_domain);
  if (!replyDomain) throw new HttpError(400, 'reply_domain is required: the subdomain whose email Cloudflare routes to this app, e.g. reply.example.com');
  const forward = normEmail(d.forward_to);
  if (forward && !isEmail(forward)) throw new HttpError(400, 'forward_to must be an email address');
  if (await env.DB.prepare('SELECT 1 FROM mailboxes WHERE email = ?').bind(email).first()) throw new HttpError(409, `A mailbox for ${email} already exists`);
  const creds = { region: d.region, accessKeyId: d.access_key_id.trim(), secretAccessKey: d.secret_access_key.trim() };
  const purpose = d.purpose ? asHttp(() => checkPurpose(d.purpose)) : 'newsletter';
  const status = await sesCheckOrThrow(creds, email);
  await env.DB.prepare(
    `INSERT INTO mailboxes (email, name, provider, purpose, refresh_token, ses_region, ses_access_key_id, ses_secret_access_key, ses_configuration_set, ses_status, reply_domain, forward_to,
       daily_limit, throttle_minutes, created_at)
     VALUES (?, ?, 'ses', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(email, d.name?.trim() || null, purpose, creds.region, creds.accessKeyId, creds.secretAccessKey, d.configuration_set?.trim() || null, JSON.stringify(status), replyDomain, forward || null,
      LIMITS.DEFAULT_DAILY_LIMIT, LIMITS.DEFAULT_THROTTLE_MINUTES, now())
    .run();
  const mb = await getMailbox(env, email);
  await ensureDefaultSender(env, mb);
  return publicMailbox(mb);
}

/** Re-check an SES mailbox's account status (sandbox, quota, verification). */
export async function recheckSes(env: Env, ref: string | number) {
  const mb = await getMailbox(env, ref);
  if (mb.provider !== 'ses') throw new HttpError(400, 'Not an SES mailbox');
  const status = await sesCheckOrThrow({ region: mb.ses_region || '', accessKeyId: mb.ses_access_key_id || '', secretAccessKey: mb.ses_secret_access_key || '' }, mb.email);
  await env.DB.prepare('UPDATE mailboxes SET ses_status = ?, last_error = NULL WHERE id = ?').bind(JSON.stringify(status), mb.id).run();
  return publicMailbox(await getMailbox(env, mb.id));
}

export async function disconnectMailbox(env: Env, ref: string | number) {
  const mb = await getMailbox(env, ref);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE mailboxes SET active = 0, refresh_token = '', access_token = NULL, watch_expires_at = NULL, ses_access_key_id = NULL, ses_secret_access_key = NULL WHERE id = ?",
    ).bind(mb.id),
    env.DB.prepare("UPDATE emails SET status = 'cancelled', status_reason = 'mailbox disconnected' WHERE mailbox_id = ? AND status = 'scheduled'").bind(mb.id),
  ]);
  return { ok: true };
}

// ---------- Scheduling ----------

export interface ScheduleInput {
  mailbox?: string | number;
  to: string;
  to_name?: string;
  subject: string;
  body_html?: string;
  body_text?: string;
  body?: string; // alias: treated as HTML if it looks like HTML, else text
  send_at?: string | number;
  campaign?: string;
  from_name?: string;
  from_email?: string;
  reply_to?: string;
  /** Sender id or key: picks the mailbox and fills From name / From address / Reply-To unless given. */
  sender?: string | number;
  metadata?: unknown;
  /** Send a saved template: subject/body are rendered from it with `vars` (CSV row). One send per address, ever. */
  template_id?: string;
  vars?: Record<string, unknown>;
  /**
   * Answer one of our sent emails: the new email goes in the same thread (In-Reply-To/References, Gmail thread).
   * Defaults: to = whoever last replied (else the original recipient), subject = "Re: …", same mailbox, sender,
   * From and Reply-To as the original, same campaign.
   */
  in_reply_to?: number | string;
  /**
   * Send through a mailbox group instead of a sender/mailbox: the email goes to whichever member has the
   * earliest free slot (by its own limits and warm-up), as that mailbox's default sender. Group sends are
   * always planned; send_at (or start_at) is the earliest time. A recipient who already got email from a
   * member stays with that member.
   */
  group?: string | number;
}

type ReplyInput = ScheduleInput & { _parent?: number; _parent_mailbox?: number };

/** Fill a reply's defaults from the email it answers. */
async function withReplyDefaults(env: Env, e: ScheduleInput, i: number): Promise<ReplyInput> {
  const pid = Number(e.in_reply_to);
  if (!Number.isInteger(pid) || pid < 1) throw new HttpError(400, `emails[${i}]: in_reply_to must be the id of an email`);
  const p = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(pid).first<EmailRow>();
  if (!p) throw new HttpError(404, `emails[${i}]: email ${pid} not found`);
  if (!p.sent_at || !p.message_id_header) throw new HttpError(400, `emails[${i}]: email ${pid} hasn't been sent, so there's nothing to reply to`);
  const last = await env.DB.prepare("SELECT from_email FROM replies WHERE email_id = ? AND kind IN ('reply','stop') ORDER BY received_at DESC LIMIT 1")
    .bind(pid)
    .first<{ from_email: string | null }>();
  const named = (v: unknown) => v !== undefined && v !== null && v !== '';
  const senderAlive = p.sender_id ? !!(await env.DB.prepare('SELECT 1 FROM senders WHERE id = ?').bind(p.sender_id).first()) : false;
  const own = named(e.sender) || named(e.mailbox);
  return {
    ...e,
    group: undefined, // a reply goes from the mailbox of the email it answers
    _parent: p.id,
    _parent_mailbox: p.mailbox_id,
    to: named(e.to) ? e.to : last?.from_email || p.to_email,
    to_name: named(e.to) ? e.to_name : (e.to_name ?? (last?.from_email && last.from_email !== p.to_email ? undefined : p.to_name ?? undefined)),
    subject: e.subject || (e.template_id ? '' : `Re: ${p.subject.replace(/^(\s*re:\s*)+/i, '')}`),
    campaign: e.campaign ?? p.campaign ?? undefined,
    mailbox: own ? e.mailbox : p.mailbox_id,
    sender: own ? e.sender : senderAlive ? p.sender_id! : undefined,
    // Same From and Reply-To as the email being answered, unless given or a different sender was picked.
    from_name: e.from_name ?? (named(e.sender) ? undefined : p.from_name ?? undefined),
    from_email: e.from_email ?? (named(e.sender) ? undefined : p.from_email ?? undefined),
    reply_to: e.reply_to ?? (named(e.sender) ? undefined : p.reply_to ?? undefined),
  };
}

export interface ScheduleOptions {
  /** Ignore per-email send_at and give each email the earliest slot its mailbox's throttle and daily limit allow. */
  auto?: boolean;
  /** With auto: don't schedule anything before this time (default now). */
  start_at?: string | number;
  /** Internal: series and step for each input (by index), stored on the email. */
  tags?: ({ series_id: number; series_step_id: number } | undefined)[];
}

interface PendingEmail {
  index: number;
  mb: MailboxRow;
  to: string;
  input: ScheduleInput;
  html: string;
  text: string;
  campaign: string | null;
  send_at: number;
  template_id: string | null;
  sender_id: number | null;
  parent_email_id: number | null;
  group: GroupCtx | null;
}

interface GroupCtx {
  row: GroupRow;
  members: MailboxRow[];
  /** Shared purpose of the members, or null if they differ (then any do-not-send entry blocks). */
  purpose: Purpose | null;
}

async function groupCtx(env: Env, ref: string | number): Promise<GroupCtx> {
  const row = await getGroupRow(env, ref);
  const all = (await env.DB.prepare('SELECT * FROM mailboxes WHERE group_id = ? ORDER BY id').bind(row.id).all<MailboxRow>()).results;
  const members = all.filter((m) => m.active && isConnected(m));
  if (!members.length) throw new HttpError(400, `Group "${row.name}" has no active, connected mailboxes`);
  const purposes = [...new Set(members.map((m) => purposeOf(m)))];
  return { row, members, purpose: purposes.length === 1 ? purposes[0] : null };
}

/**
 * Spread `count` sends across mailboxes: each email takes the earliest free slot of any member, by that
 * member's own throttle, daily limit and warm-up. prefer[i] pins email i to a mailbox id (same recipient,
 * same mailbox). Each member's slots are planned independently, so merging them is exact.
 */
export async function planAcrossMailboxes(env: Env, members: MailboxRow[], count: number, start: number, prefer: (number | null)[] = []) {
  const slots = new Map<number, number[]>();
  const ptr = new Map<number, number>();
  for (const m of members) {
    slots.set(m.id, count ? await planForMailbox(env, m, count, start) : []);
    ptr.set(m.id, 0);
  }
  const byId = new Map(members.map((m) => [m.id, m]));
  const out: { mb: MailboxRow; at: number }[] = [];
  for (let i = 0; i < count; i++) {
    let pick = prefer[i] !== undefined && prefer[i] !== null && slots.has(prefer[i]!) ? prefer[i]! : null;
    if (pick === null) {
      let best = Infinity;
      for (const m of members) {
        const t = slots.get(m.id)![ptr.get(m.id)!];
        if (t !== undefined && t < best) (best = t), (pick = m.id);
      }
    }
    const k = ptr.get(pick!)!;
    out.push({ mb: byId.get(pick!)!, at: slots.get(pick!)![k] });
    ptr.set(pick!, k + 1);
  }
  return out;
}

/** Preview where `count` emails sent through a group would go out, and from which mailboxes. Schedules nothing. */
export async function previewGroupPlan(env: Env, ref: string | number, count: number, startAt?: string | number) {
  const g = await groupCtx(env, ref);
  const n = Math.min(Math.max(Math.floor(Number(count) || 0), 0), 1000);
  const plan = await planAcrossMailboxes(env, g.members, n, Math.max(now(), parseTime(startAt)));
  const slots = plan.map((p) => p.at).sort((a, b) => a - b);
  return {
    group: g.row.name,
    count: n,
    first_send_at: iso(slots[0]),
    last_send_at: iso(slots[slots.length - 1]),
    slots: slots.map((t) => iso(t)!),
    mailboxes: g.members.map((m) => {
      const mine = plan.filter((p) => p.mb.id === m.id).map((p) => p.at);
      return { mailbox: m.email, count: mine.length, today_limit: dailyLimitAt(m, now()), warming_up: !!m.warmup_enabled, first_send_at: iso(mine[0]), last_send_at: iso(mine[mine.length - 1]) };
    }),
  };
}

export async function scheduleEmails(env: Env, inputs: ScheduleInput[], opts: ScheduleOptions = {}) {
  if (!Array.isArray(inputs) || !inputs.length) throw new HttpError(400, 'No emails provided');
  if (inputs.length > 1000) throw new HttpError(400, 'Max 1000 emails per request');
  const mailboxes = new Map<string, MailboxRow>();
  const senders = new Map<string, SenderLite>();
  const skipped: { index: number; to: string; reason: string }[] = [];
  const pending: PendingEmail[] = [];
  const templates = new Map<string, TemplateRow>();
  const seen = new Set<string>(); // template|address within this request
  const groups = new Map<string, GroupCtx>();
  const fromChecked = new Set<string>(); // mailbox|From address already verified in this request

  inputs = await Promise.all(inputs.map((e, i) => (e && e.in_reply_to !== undefined && e.in_reply_to !== null && e.in_reply_to !== '' ? withReplyDefaults(env, e, i) : e)));
  const dncMap = await dncScopes(env, inputs.map((i) => normEmail(i.to)));

  for (let i = 0; i < inputs.length; i++) {
    let e: ReplyInput = inputs[i];
    const to = normEmail(e.to);
    let templateId: string | null = null;
    if (e.template_id) {
      templateId = normTemplateId(e.template_id);
      let t = templates.get(templateId);
      if (!t) {
        t = await getTemplateRow(env, templateId);
        templates.set(templateId, t);
      }
      const vars: Record<string, string> = { ...normVars(e.vars), to, ...(e.to_name ? { to_name: String(e.to_name) } : {}) };
      const missing = missingValues(t, vars);
      if (missing.length) {
        skipped.push({ index: i, to: e.to, reason: `missing value for ${missing.join(', ')}` });
        continue;
      }
      if (seen.has(`${templateId}|${to}`)) {
        skipped.push({ index: i, to, reason: 'duplicate row for this template' });
        continue;
      }
      seen.add(`${templateId}|${to}`);
      if (!e.subject && !e.body && !e.body_html && !e.body_text) {
        const { to: _t, to_name: _n, name: _nm, ...rest } = vars;
        e = { ...e, ...renderTemplate(t, vars), to_name: e.to_name || vars.to_name || vars.name || undefined, metadata: e.metadata ?? (Object.keys(rest).length ? rest : undefined) };
      }
    }
    if (!isEmail(to)) {
      skipped.push({ index: i, to: e.to, reason: 'invalid recipient' });
      continue;
    }
    if (!e.subject) throw new HttpError(400, `emails[${i}]: subject is required (or use template_id)`);
    let html = e.body_html || '';
    let text = e.body_text || '';
    if (e.body && !html && !text) {
      if (/<[a-z][\s\S]*>/i.test(e.body)) html = e.body;
      else text = e.body;
    }
    if (!html && !text) throw new HttpError(400, `emails[${i}]: body_html, body_text or body is required`);
    // Group → a member is picked after planning; sender → mailbox; or mailbox → its default sender.
    let grp: GroupCtx | null = null;
    if (e.group !== undefined && e.group !== null && e.group !== '') {
      if ((e.sender !== undefined && e.sender !== null && e.sender !== '') || (e.mailbox !== undefined && e.mailbox !== null && e.mailbox !== '')) {
        throw new HttpError(400, `emails[${i}]: give a group, or a sender or mailbox, not both`);
      }
      if (e.from_email) throw new HttpError(400, `emails[${i}]: from_email can't be set with a group; each mailbox sends as its default sender`);
      const gk = String(e.group).trim().toLowerCase();
      grp = groups.get(gk) || (await groupCtx(env, e.group));
      groups.set(gk, grp);
    }
    let sender: SenderLite | null = null;
    let mb: MailboxRow | undefined;
    if (grp) {
      mb = grp.members[0]; // placeholder until the group is planned
    } else if (e.sender !== undefined && e.sender !== null && e.sender !== '') {
      const sk = `s:${e.sender}`;
      sender = senders.get(sk) || (await senderRef(env, e.sender));
      senders.set(sk, sender);
      mb = mailboxes.get(`id:${sender.mailbox_id}`) || (await getMailbox(env, sender.mailbox_id));
      mailboxes.set(`id:${mb.id}`, mb);
      if (e.mailbox !== undefined && e.mailbox !== null && e.mailbox !== '') {
        // Cached like everything else in this loop: a database call per recipient would hit
        // Cloudflare's limit of 1000 calls per invocation on a big list.
        const nk = String(e.mailbox);
        const named = mailboxes.get(nk) || (await getMailbox(env, e.mailbox));
        mailboxes.set(nk, named);
        if (named.id !== mb.id) throw new HttpError(400, `emails[${i}]: sender "${sender.key}" belongs to ${mb.email}, not ${named.email}`);
      }
    } else {
      const key = String(e.mailbox ?? '');
      if (!key) throw new HttpError(400, `emails[${i}]: sender or mailbox is required`);
      mb = mailboxes.get(key);
      if (!mb) {
        mb = await getMailbox(env, key);
        mailboxes.set(key, mb);
      }
      const dk = `d:${mb.id}`;
      if (!senders.has(dk)) {
        const d = await env.DB.prepare('SELECT * FROM senders WHERE mailbox_id = ? ORDER BY is_default DESC, id LIMIT 1').bind(mb.id).first<SenderLite>();
        if (d) senders.set(dk, d);
      }
      sender = senders.get(dk) || null;
    }
    if (!mb.active || !isConnected(mb)) throw new HttpError(400, `Mailbox ${mb.email} is not active`);
    if (e._parent_mailbox && e._parent_mailbox !== mb.id) throw new HttpError(400, `emails[${i}]: a reply must go from the same mailbox as the email it answers`);
    // Opt-outs are scoped: e.g. a newsletter unsubscribe doesn't stop a conversation mailbox answering them.
    if (dncMap.has(to) && scopeBlocks(dncMap.get(to), grp ? grp.purpose : purposeOf(mb))) {
      skipped.push({ index: i, to, reason: 'do-not-send list' });
      continue;
    }
    const given = (v: string | undefined) => (v !== undefined && v !== null && String(v).trim() !== '' ? v : undefined);
    e = {
      ...e,
      from_name: given(e.from_name) ?? sender?.from_name ?? undefined,
      from_email: given(e.from_email) ?? sender?.from_email ?? undefined,
      reply_to: given(e.reply_to) ?? sender?.reply_to ?? undefined,
    };
    if (!grp && e.from_email && normEmail(e.from_email) !== mb.email) {
      const fk = `${mb.id}|${normEmail(e.from_email)}`;
      if (!fromChecked.has(fk)) {
        await checkFromEmail(env, mb, normEmail(e.from_email));
        fromChecked.add(fk);
      }
    }
    if (e.reply_to && !isEmail(normEmail(e.reply_to))) throw new HttpError(400, `emails[${i}]: reply_to must be an email address`);
    pending.push({ index: i, mb, to, input: e, html, text, campaign: e.campaign?.trim() || null, send_at: opts.auto ? 0 : parseTime(e.send_at), template_id: templateId, sender_id: sender?.id ?? null, parent_email_id: e._parent ?? null, group: grp });
  }

  // A template reaches an address once: drop anyone who already has it queued or sent.
  for (const tid of new Set(pending.map((p) => p.template_id).filter(Boolean) as string[])) {
    const taken = await templateRecipients(env, tid, pending.filter((p) => p.template_id === tid).map((p) => p.to));
    if (!taken.size) continue;
    for (let k = pending.length - 1; k >= 0; k--) {
      const p = pending[k];
      const st = p.template_id === tid ? taken.get(p.to) : undefined;
      if (!st) continue;
      skipped.push({ index: p.index, to: p.to, reason: st === 'scheduled' || st === 'sending' ? 'template already scheduled for this address' : 'already received this template' });
      pending.splice(k, 1);
    }
  }
  skipped.sort((a, b) => a.index - b.index);

  // Auto: assign slots per mailbox, in input order.
  const plan: { mailbox?: string; group?: string; count: number; first_send_at: string | null; last_send_at: string | null; daily_limit?: number; throttle_minutes?: number; mailboxes?: { mailbox: string; count: number }[] }[] = [];

  // Groups: always planned; each email goes to the member with the earliest free slot.
  const byGroup = new Map<number, PendingEmail[]>();
  for (const p of pending) if (p.group) byGroup.set(p.group.row.id, [...(byGroup.get(p.group.row.id) || []), p]);
  for (const [, list] of byGroup) {
    const g = list[0].group!;
    const start = Math.max(now(), opts.auto ? parseTime(opts.start_at) : Math.min(...list.map((p) => p.send_at)));
    const ids = g.members.map((m) => m.id);
    // Same recipient, same mailbox: keep follow-ups to someone on the mailbox they already heard from.
    const sticky = new Map<string, number>();
    const tos = [...new Set(list.map((p) => p.to))];
    for (let k = 0; k < tos.length; k += 90) {
      const chunk = tos.slice(k, k + 90);
      const r = await env.DB.prepare(
        `SELECT to_email, mailbox_id FROM emails WHERE mailbox_id IN (${ids.map(() => '?').join(',')}) AND to_email IN (${chunk.map(() => '?').join(',')})
         AND status IN ('scheduled','sending','sent','bounced') ORDER BY created_at`,
      )
        .bind(...ids, ...chunk)
        .all<{ to_email: string; mailbox_id: number }>();
      r.results.forEach((x) => sticky.set(x.to_email, x.mailbox_id));
    }
    const assigned = await planAcrossMailboxes(env, g.members, list.length, start, list.map((p) => sticky.get(p.to) ?? null));
    const defaults = new Map<number, SenderLite>();
    for (const s of (await env.DB.prepare(`SELECT * FROM senders WHERE mailbox_id IN (${ids.map(() => '?').join(',')}) ORDER BY is_default, id DESC`).bind(...ids).all<SenderLite>()).results) {
      defaults.set(s.mailbox_id, s); // last one wins: the default (or the oldest sender)
    }
    list.forEach((p, k) => {
      const { mb, at } = assigned[k];
      const d = defaults.get(mb.id);
      p.mb = mb;
      p.send_at = at;
      p.sender_id = d?.id ?? null;
      p.input = { ...p.input, from_name: p.input.from_name ?? d?.from_name ?? undefined, from_email: d?.from_email ?? undefined, reply_to: p.input.reply_to ?? d?.reply_to ?? undefined };
    });
    const times = assigned.map((a) => a.at).sort((a, b) => a - b);
    plan.push({
      group: g.row.name,
      count: list.length,
      first_send_at: iso(times[0]),
      last_send_at: iso(times[times.length - 1]),
      mailboxes: g.members.map((m) => ({ mailbox: m.email, count: assigned.filter((a) => a.mb.id === m.id).length })),
    });
  }

  if (opts.auto && pending.some((p) => !p.group)) {
    const start = Math.max(now(), parseTime(opts.start_at));
    const byMailbox = new Map<number, PendingEmail[]>();
    for (const p of pending) if (!p.group) byMailbox.set(p.mb.id, [...(byMailbox.get(p.mb.id) || []), p]);
    for (const [, list] of byMailbox) {
      const mb = list[0].mb;
      const slots = await planForMailbox(env, mb, list.length, start);
      list.forEach((p, i) => (p.send_at = slots[i]));
      plan.push({
        mailbox: mb.email,
        count: list.length,
        first_send_at: iso(slots[0]),
        last_send_at: iso(slots[slots.length - 1]),
        daily_limit: mb.daily_limit,
        throttle_minutes: mb.throttle_minutes,
      });
    }
  }

  const scheduled: { id: number; to: string; send_at: string; campaign: string | null; template_id: string | null }[] = [];
  if (pending.length) {
    const res = await env.DB.batch(
      pending.map((p) =>
        env.DB.prepare(
          // OR IGNORE: the template-once unique index wins any race with a concurrent upload.
          `INSERT OR IGNORE INTO emails (mailbox_id, sender_id, campaign, from_name, from_email, reply_to, to_email, to_name, subject, body_html, body_text, send_at, track_token, metadata, template_id, parent_email_id, group_id, series_id, series_step_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          p.mb.id,
          p.sender_id,
          p.campaign,
          p.input.from_name || null,
          p.input.from_email ? normEmail(p.input.from_email) : null,
          p.input.reply_to ? normEmail(p.input.reply_to) : null,
          p.to,
          p.input.to_name || null,
          p.input.subject,
          p.html || null,
          p.text || null,
          p.send_at,
          randomToken(),
          p.input.metadata === undefined ? null : JSON.stringify(p.input.metadata),
          p.template_id,
          p.parent_email_id,
          p.group?.row.id ?? null,
          opts.tags?.[p.index]?.series_id ?? null,
          opts.tags?.[p.index]?.series_step_id ?? null,
          now(),
        ),
      ),
    );
    res.forEach((r, i) => {
      const p = pending[i];
      if (!r.meta.changes) skipped.push({ index: p.index, to: p.to, reason: 'already received this template' });
      else scheduled.push({ id: Number(r.meta.last_row_id), to: p.to, send_at: iso(p.send_at)!, campaign: p.campaign, template_id: p.template_id });
    });
  }
  return opts.auto || byGroup.size ? { scheduled, skipped, plan } : { scheduled, skipped };
}

/** Send times this mailbox has already used or reserved (input for the planner). */
async function occupiedTimes(env: Env, mailboxId: number): Promise<number[]> {
  const t = now();
  const rows = await env.DB.prepare(
    `SELECT CASE WHEN status = 'scheduled' THEN MAX(send_at, ?) WHEN status = 'sending' THEN COALESCE(claimed_at, send_at) ELSE sent_at END AS t
     FROM emails WHERE mailbox_id = ? AND (status IN ('scheduled', 'sending') OR (status IN ('sent', 'bounced') AND sent_at >= ?))`,
  )
    .bind(t, mailboxId, t - LIMITS.WINDOW_MS)
    .all<{ t: number }>();
  return rows.results.map((r) => r.t);
}

export async function planForMailbox(env: Env, mb: MailboxRow, count: number, start: number): Promise<number[]> {
  // Cold outreach: uneven gaps, so sends don't arrive like clockwork. Seeded, so the preview matches.
  const { jitter } = mailFormat(mb);
  const rnd = seededRandom(mb.id * 7919 + count);
  const jitterMs = jitter ? () => Math.round(rnd() * jitter * mb.throttle_minutes * 60_000) : undefined;
  return planSlots({
    jitterMs,
    limitAt: (t) => dailyLimitAt(mb, t),
    occupied: await occupiedTimes(env, mb.id),
    count,
    start,
    gapMs: mb.throttle_minutes * 60_000 + LIMITS.PLAN_SLACK_MS / 4,
    limit: mb.daily_limit,
    windowMs: LIMITS.WINDOW_MS + LIMITS.PLAN_SLACK_MS,
  });
}

/** Preview where `count` auto-scheduled emails would land for a mailbox, without scheduling anything. */
export async function previewPlan(env: Env, mailbox: string | number, count: number, startAt?: string | number) {
  const mb = await getMailbox(env, mailbox);
  const n = Math.min(Math.max(Math.floor(Number(count) || 0), 0), 1000);
  const start = Math.max(now(), parseTime(startAt));
  const slots = n ? await planForMailbox(env, mb, n, start) : [];
  return {
    mailbox: mb.email,
    daily_limit: mb.daily_limit,
    today_limit: dailyLimitAt(mb, now()),
    warmup: warmupInfo(mb),
    throttle_minutes: mb.throttle_minutes,
    count: n,
    first_send_at: iso(slots[0]),
    last_send_at: iso(slots[slots.length - 1]),
    slots: slots.map((t) => iso(t)!),
  };
}

export function publicEmail(e: EmailRow, includeBody = false) {
  return {
    id: e.id,
    mailbox_id: e.mailbox_id,
    campaign: e.campaign,
    sender_id: e.sender_id,
    template_id: e.template_id,
    in_reply_to: e.parent_email_id ?? null,
    group_id: e.group_id ?? null,
    series_id: e.series_id ?? null,
    series_step_id: e.series_step_id ?? null,
    ai: e.ai_status ? { status: e.ai_status, note: e.ai_note, model: e.ai_model, cost: e.ai_cost, at: iso(e.personalized_at) } : null,
    from_name: e.from_name,
    from_email: e.from_email,
    reply_to: e.reply_to,
    to: e.to_email,
    to_name: e.to_name,
    subject: e.subject,
    ...(includeBody ? { body_html: e.body_html, body_text: e.body_text } : {}),
    send_at: iso(e.send_at),
    status: e.status,
    status_reason: e.status_reason,
    sent_at: iso(e.sent_at),
    open_count: e.open_count,
    first_opened_at: iso(e.first_opened_at),
    last_opened_at: iso(e.last_opened_at),
    reply_count: e.reply_count,
    last_reply_at: iso(e.last_reply_at),
    gmail_thread_id: e.gmail_thread_id,
    metadata: e.metadata ? JSON.parse(e.metadata) : null,
    created_at: iso(e.created_at),
  };
}

export interface EmailFilter {
  campaign?: string;
  status?: string;
  mailbox?: string | number;
  to?: string;
  q?: string;
  opened?: boolean;
  replied?: boolean;
  template?: string;
  sender?: string | number;
  purpose?: string;
  group?: string | number;
  /** Series name or id */
  series?: string | number;
  limit?: number;
  offset?: number;
}

/** WHERE parts (emails aliased "e") for a filter, without its status. */
async function emailWhere(env: Env, f: EmailFilter) {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (f.campaign !== undefined && f.campaign !== '') {
    if (f.campaign === '(none)') where.push('e.campaign IS NULL');
    else (where.push('e.campaign = ?'), vals.push(f.campaign));
  }
  if (f.mailbox) {
    const mb = await getMailbox(env, f.mailbox);
    where.push('e.mailbox_id = ?');
    vals.push(mb.id);
  }
  if (f.to) (where.push('e.to_email = ?'), vals.push(normEmail(f.to)));
  if (f.q) {
    where.push('(e.to_email LIKE ? OR e.subject LIKE ? OR e.to_name LIKE ?)');
    vals.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  if (f.opened) where.push('e.open_count > 0');
  if (f.replied) where.push('e.reply_count > 0');
  if (f.template) (where.push('e.template_id = ?'), vals.push(String(f.template).toLowerCase()));
  if (f.sender !== undefined && f.sender !== '') (where.push('e.sender_id = ?'), vals.push((await senderRef(env, f.sender)).id));
  if (f.purpose) (where.push('e.mailbox_id IN (SELECT id FROM mailboxes WHERE purpose = ?)'), vals.push(asHttp(() => checkPurpose(f.purpose))));
  if (f.group !== undefined && f.group !== '') (where.push('e.group_id = ?'), vals.push((await getGroupRow(env, f.group)).id));
  if (f.series !== undefined && f.series !== '') {
    const byId = /^\d+$/.test(String(f.series));
    const sr = await env.DB.prepare(`SELECT id FROM series WHERE ${byId ? 'id' : 'name'} = ?`).bind(byId ? Number(f.series) : String(f.series)).first<{ id: number }>();
    if (!sr) throw new HttpError(404, `Series not found: ${f.series}`);
    where.push('e.series_id = ?');
    vals.push(sr.id);
  }
  return { where, vals };
}

const statusList = (status: unknown) => String(status ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export async function listEmails(env: Env, f: EmailFilter) {
  const { where, vals } = await emailWhere(env, f);
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  // Per-status counts ignore the status filter so the UI can show them on its status tabs.
  const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const baseVals = [...vals];
  if (f.status) {
    const sts = statusList(f.status);
    where.push(`e.status IN (${sts.map(() => '?').join(',')})`);
    vals.push(...sts);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, count, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT e.*, m.email AS mailbox_email, m.name AS mailbox_name,
         substr(COALESCE(e.body_text, e.body_html, ''), 1, 400) AS snippet_src
       FROM emails e JOIN mailboxes m ON m.id = e.mailbox_id ${w}
       ORDER BY CASE WHEN e.status = 'scheduled' THEN 0 ELSE 1 END, CASE WHEN e.status = 'scheduled' THEN e.send_at END ASC, COALESCE(e.sent_at, e.send_at) DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...vals, limit, offset)
      .all<EmailRow & { mailbox_email: string; mailbox_name: string | null; snippet_src: string }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM emails e ${w}`).bind(...vals).first<{ n: number }>(),
    env.DB.prepare(`SELECT e.status, COUNT(*) AS n FROM emails e ${baseWhere} GROUP BY e.status`).bind(...baseVals).all<{ status: string; n: number }>(),
  ]);
  return {
    total: count?.n ?? 0,
    limit,
    offset,
    counts: Object.fromEntries(counts.results.map((c) => [c.status, c.n])),
    emails: rows.results.map((r) => ({
      ...publicEmail(r),
      mailbox: r.mailbox_email,
      mailbox_name: r.mailbox_name,
      snippet: snippet(r.snippet_src),
    })),
  };
}

function snippet(src: string | null): string {
  return (src || '')
    .replace(/<(style|script)[\s\S]*?(<\/\1>|$)/gi, ' ')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export async function getEmailRow(env: Env, id: number): Promise<EmailRow> {
  const e = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first<EmailRow>();
  if (!e) throw new HttpError(404, `Email ${id} not found`);
  return e;
}

export async function getEmail(env: Env, id: number) {
  const e = await getEmailRow(env, id);
  const [mb, opens, replies] = await Promise.all([
    getMailbox(env, e.mailbox_id),
    env.DB.prepare('SELECT opened_at, ip, user_agent FROM opens WHERE email_id = ? ORDER BY opened_at DESC LIMIT 100').bind(id).all<{ opened_at: number; ip: string; user_agent: string }>(),
    env.DB.prepare('SELECT * FROM replies WHERE email_id = ? ORDER BY received_at').bind(id).all<ReplyRow>(),
  ]);
  const sender = e.sender_id ? await env.DB.prepare('SELECT id, key, label FROM senders WHERE id = ?').bind(e.sender_id).first<{ id: number; key: string; label: string }>() : null;
  return {
    ...publicEmail(e, true),
    sender,
    mailbox: mb.email,
    mailbox_name: mb.name,
    opens: opens.results.map((o) => ({ ...o, opened_at: iso(o.opened_at) })),
    replies: replies.results.map(publicReply),
  };
}

/**
 * Which emails a bulk action is for: ids, or every email matching a filter (the same filter as listing them,
 * across all pages) minus exclude_ids.
 */
export interface EmailSelection {
  ids?: number[];
  filter?: EmailFilter;
  exclude_ids?: number[];
}

const MAX_EMAIL_SELECT = 100_000;
const ID_CHUNK = 90; // D1 allows at most 100 bound values per statement

/** Ids of the selected emails that are still scheduled. */
async function selectedScheduled(env: Env, sel: EmailSelection): Promise<number[]> {
  const ids = new Set<number>();
  const listed = [...new Set((sel.ids || []).map(Number).filter(Number.isInteger))];
  for (let i = 0; i < listed.length; i += ID_CHUNK) {
    const chunk = listed.slice(i, i + ID_CHUNK);
    const r = await env.DB.prepare(`SELECT id FROM emails WHERE status = 'scheduled' AND id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: number }>();
    r.results.forEach((x) => ids.add(x.id));
  }
  if (sel.filter && typeof sel.filter === 'object') {
    // Only scheduled emails can be cancelled or sent now, whatever status the view shows.
    const sts = statusList(sel.filter.status);
    if (!sts.length || sts.includes('scheduled')) {
      const { where, vals } = await emailWhere(env, sel.filter);
      const r = await env.DB.prepare(`SELECT e.id FROM emails e WHERE ${['e.status = \'scheduled\'', ...where].join(' AND ')} ORDER BY e.send_at, e.id LIMIT ${MAX_EMAIL_SELECT + 1}`)
        .bind(...vals)
        .all<{ id: number }>();
      if (r.results.length > MAX_EMAIL_SELECT) throw new HttpError(400, `More than ${MAX_EMAIL_SELECT} emails match; narrow the filter`);
      r.results.forEach((x) => ids.add(x.id));
    }
  }
  (sel.exclude_ids || []).forEach((id) => ids.delete(Number(id)));
  return [...ids];
}

/** Run one UPDATE per chunk of ids, in batches; returns how many rows changed. */
async function updateByIds(env: Env, sql: (placeholders: string) => string, head: unknown[], ids: number[]) {
  let changed = 0;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    stmts.push(env.DB.prepare(sql(chunk.map(() => '?').join(','))).bind(...head, ...chunk));
  }
  for (let i = 0; i < stmts.length; i += 100) (await env.DB.batch(stmts.slice(i, i + 100))).forEach((r) => (changed += r.meta.changes));
  return changed;
}

/** Cancel scheduled (unsent) emails: a selection (ids or filter), or everything for a campaign and/or recipient. */
export async function cancelEmails(env: Env, p: EmailSelection & { campaign?: string; to?: string }) {
  if (p.ids?.length || p.filter) {
    const ids = await selectedScheduled(env, p);
    return { cancelled: await updateByIds(env, (q) => `UPDATE emails SET status = 'cancelled', status_reason = 'cancelled by user' WHERE status = 'scheduled' AND id IN (${q})`, [], ids) };
  }
  const where: string[] = ["status = 'scheduled'"];
  const vals: unknown[] = [];
  if (p.campaign) (where.push('campaign = ?'), vals.push(p.campaign));
  if (p.to) (where.push('to_email = ?'), vals.push(normEmail(p.to)));
  if (where.length === 1) throw new HttpError(400, 'Provide ids, filter, campaign or to');
  const r = await env.DB.prepare(`UPDATE emails SET status = 'cancelled', status_reason = 'cancelled by user' WHERE ${where.join(' AND ')}`).bind(...vals).run();
  return { cancelled: r.meta.changes };
}

/** How many emails "send now" sends in the request itself; the rest go out with the next cron runs. */
export const SEND_NOW_DIRECT = 25;

/**
 * Make the selected scheduled emails due now. The first few are sent straight away; the rest are sent by
 * the every-minute run, still within each mailbox's daily limit and spacing.
 */
export async function sendNow(env: Env, sel: EmailSelection, send: (ids: number[]) => Promise<{ sent: number; failed: number; skipped: number; deferred: number }>) {
  if (!sel.ids?.length && !sel.filter) throw new HttpError(400, 'Provide ids or filter');
  const ids = await selectedScheduled(env, sel);
  if (!ids.length) return { sent: 0, failed: 0, skipped: 0, deferred: 0, queued: 0 };
  await updateByIds(env, (q) => `UPDATE emails SET send_at = ? WHERE status = 'scheduled' AND id IN (${q})`, [now()], ids);
  const direct = ids.slice(0, SEND_NOW_DIRECT);
  return { ...(await send(direct)), queued: ids.length - direct.length };
}

export async function updateScheduledEmail(env: Env, id: number, patch: Partial<ScheduleInput>) {
  const e = await getEmailRow(env, id);
  if (e.status !== 'scheduled' && e.status !== 'cancelled' && e.status !== 'failed') {
    throw new HttpError(409, `Email ${id} is ${e.status}; only scheduled, cancelled or failed emails can be edited`);
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
  if (patch.send_at !== undefined) set('send_at', parseTime(patch.send_at));
  if (patch.subject !== undefined) set('subject', patch.subject);
  if (patch.body_html !== undefined) set('body_html', patch.body_html || null);
  if (patch.body_text !== undefined) set('body_text', patch.body_text || null);
  if (patch.campaign !== undefined) set('campaign', patch.campaign || null);
  if (patch.to_name !== undefined) set('to_name', patch.to_name || null);
  if (patch.from_name !== undefined) set('from_name', patch.from_name || null);
  if (patch.reply_to !== undefined) {
    const r = normEmail(patch.reply_to);
    if (r && !isEmail(r)) throw new HttpError(400, 'reply_to must be an email address');
    set('reply_to', r || null);
  }
  if (patch.from_email !== undefined) {
    const f = normEmail(patch.from_email);
    const mbId = patch.mailbox !== undefined ? (await getMailbox(env, patch.mailbox)).id : e.mailbox_id;
    if (f) await checkFromEmail(env, await getMailbox(env, mbId), f);
    set('from_email', f || null);
  }
  if (patch.mailbox !== undefined) set('mailbox_id', (await getMailbox(env, patch.mailbox)).id);
  if (patch.sender !== undefined && patch.sender !== null && patch.sender !== '') {
    const s = await senderRef(env, patch.sender);
    set('sender_id', s.id);
    set('mailbox_id', s.mailbox_id);
    if (patch.from_name === undefined) set('from_name', s.from_name);
    if (patch.from_email === undefined) set('from_email', s.from_email);
    if (patch.reply_to === undefined) set('reply_to', s.reply_to);
  }
  // Editing a cancelled/failed email re-queues it.
  set('status', 'scheduled');
  set('status_reason', null);
  set('attempts', 0);
  try {
    await env.DB.prepare(`UPDATE emails SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  } catch (err) {
    if (/UNIQUE/i.test(String((err as Error).message))) {
      throw new HttpError(409, `${e.to_email} already has template "${e.template_id}" scheduled or sent, so this email can't be re-queued`);
    }
    throw err;
  }
  return publicEmail(await getEmailRow(env, id), true);
}

// ---------- Replies ----------

export interface ReplyRow {
  id: number;
  email_id: number;
  mailbox_id: number;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  received_at: number;
  text: string | null;
  full_text: string | null;
  kind: string;
  webhook_status: string;
  webhook_attempts: number;
  webhook_response: string | null;
  category: string | null;
  category_source: string | null;
  category_error: string | null;
  category_cost: number | null;
  message_id_header: string | null;
  created_at: number;
}

export function publicReply(r: ReplyRow) {
  return {
    id: r.id,
    email_id: r.email_id,
    from: r.from_email,
    from_name: r.from_name,
    subject: r.subject,
    received_at: iso(r.received_at),
    kind: r.kind,
    category: r.category,
    category_source: r.category_source,
    category_error: r.category_error,
    text: r.text,
    webhook_status: r.webhook_status,
    webhook_attempts: r.webhook_attempts,
    webhook_response: r.webhook_response,
  };
}

export async function listReplies(
  env: Env,
  f: { campaign?: string; mailbox?: string | number; kind?: string; category?: string; since?: string; purpose?: string; group?: string | number; limit?: number; offset?: number },
) {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (f.campaign) (where.push('e.campaign = ?'), vals.push(f.campaign));
  if (f.mailbox) (where.push('r.mailbox_id = ?'), vals.push((await getMailbox(env, f.mailbox)).id));
  if (f.purpose) (where.push('r.mailbox_id IN (SELECT id FROM mailboxes WHERE purpose = ?)'), vals.push(asHttp(() => checkPurpose(f.purpose))));
  if (f.group !== undefined && f.group !== '') (where.push('e.group_id = ?'), vals.push((await getGroupRow(env, f.group)).id));
  if (f.kind) (where.push('r.kind = ?'), vals.push(f.kind));
  if (f.category === '(none)') where.push("r.category IS NULL AND r.kind IN ('reply','stop')");
  else if (f.category) (where.push('r.category = ?'), vals.push(f.category));
  if (f.since) (where.push('r.received_at >= ?'), vals.push(parseTime(f.since)));
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `SELECT r.*, e.campaign, e.subject AS email_subject, e.to_email, m.email AS mailbox_email
     FROM replies r JOIN emails e ON e.id = r.email_id JOIN mailboxes m ON m.id = r.mailbox_id ${w}
     ORDER BY r.received_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...vals, limit, offset)
    .all<ReplyRow & { campaign: string | null; email_subject: string; to_email: string; mailbox_email: string }>();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM replies r JOIN emails e ON e.id = r.email_id ${w}`).bind(...vals).first<{ n: number }>();
  return {
    total: total?.n ?? 0,
    replies: rows.results.map((r) => ({ ...publicReply(r), campaign: r.campaign, email_subject: r.email_subject, email_to: r.to_email, mailbox: r.mailbox_email })),
  };
}

/** Fetch the whole Gmail thread for an email and break it into a conversation. */
export async function conversation(env: Env, emailId: number) {
  const e = await getEmailRow(env, emailId);
  const mb = await getMailbox(env, e.mailbox_id);
  if (!e.sent_at) throw new HttpError(409, 'Email has not been sent yet');
  if (mb.provider === 'ses' || !e.gmail_thread_id) return storedConversation(env, e, mb);
  return threadConversation(env, mb, e.gmail_thread_id);
}

/** Conversation from what we stored: our email plus recorded replies (used for SES, and when Gmail is unreachable). */
export async function storedConversation(env: Env, email: EmailRow, mb: MailboxRow) {
  const replies = (await env.DB.prepare("SELECT * FROM replies WHERE email_id = ? AND kind != 'auto' ORDER BY received_at").bind(email.id).all<ReplyRow>()).results;
  return [
    {
      gmail_message_id: email.gmail_message_id || email.ses_message_id || '',
      role: 'us',
      from: email.from_email || mb.from_email || mb.email,
      from_name: email.from_name || mb.name,
      to: email.to_email,
      subject: email.subject,
      date: email.sent_at ? new Date(email.sent_at).toISOString() : '',
      text: email.body_text || htmlToText(email.body_html || ''),
    },
    ...replies.map((r) => ({
      gmail_message_id: r.gmail_message_id,
      role: 'them',
      from: r.from_email || '',
      from_name: r.from_name,
      to: mb.email,
      subject: r.subject || '',
      date: new Date(r.received_at).toISOString(),
      text: r.text || '',
    })),
  ];
}

export async function threadConversation(env: Env, mb: MailboxRow, threadId: string) {
  const thread = await gmailApi.getThread(env, mb, threadId);
  const own = new Set([mb.email]);
  return thread.messages.map((m) => {
    const from = parseAddress(header(m, 'from'));
    const { latest } = messageText(m);
    const fromUs = own.has(from.email) || (m.labelIds || []).includes('SENT');
    return {
      gmail_message_id: m.id,
      role: fromUs ? 'us' : 'them',
      from: from.email,
      from_name: from.name,
      to: header(m, 'to'),
      subject: header(m, 'subject'),
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, 'date'),
      text: latest,
    };
  });
}

// ---------- Campaigns ----------

const STATS_SQL = `
  SELECT COALESCE(campaign, '(none)') AS campaign,
    COUNT(*) AS total,
    SUM(status = 'scheduled') AS scheduled,
    SUM(status IN ('sent','bounced')) AS sent,
    SUM(status = 'failed') AS failed,
    SUM(status = 'skipped') AS skipped,
    SUM(status = 'cancelled') AS cancelled,
    SUM(status = 'bounced') AS bounced,
    SUM(open_count > 0) AS opened,
    SUM(open_count) AS total_opens,
    SUM(reply_count > 0) AS replied,
    MIN(send_at) AS first_send_at,
    MAX(sent_at) AS last_send_at,
    MAX(created_at) AS last_created_at
  FROM emails`;

function shapeStats(r: Record<string, number | string | null>) {
  const sent = Number(r.sent) || 0;
  const pct = (n: unknown) => (sent ? Math.round((Number(n) / sent) * 1000) / 10 : 0);
  return {
    campaign: r.campaign as string,
    total: Number(r.total) || 0,
    scheduled: Number(r.scheduled) || 0,
    sent,
    failed: Number(r.failed) || 0,
    skipped: Number(r.skipped) || 0,
    cancelled: Number(r.cancelled) || 0,
    bounced: Number(r.bounced) || 0,
    opened: Number(r.opened) || 0,
    total_opens: Number(r.total_opens) || 0,
    replied: Number(r.replied) || 0,
    stopped: Number(r.stopped) || 0,
    open_rate: pct(r.opened),
    reply_rate: pct(r.replied),
    first_send_at: iso(r.first_send_at as number),
    last_send_at: iso(r.last_send_at as number),
  };
}

export async function listCampaigns(env: Env) {
  const [rows, stops] = await Promise.all([
    env.DB.prepare(`${STATS_SQL} GROUP BY COALESCE(campaign, '(none)') ORDER BY last_created_at DESC`).all<Record<string, number | string | null>>(),
    env.DB.prepare(
      `SELECT COALESCE(e.campaign, '(none)') AS campaign, COUNT(DISTINCT r.from_email) AS n FROM replies r JOIN emails e ON e.id = r.email_id WHERE r.kind = 'stop' GROUP BY 1`,
    ).all<{ campaign: string; n: number }>(),
  ]);
  const stopMap = new Map(stops.results.map((s) => [s.campaign, s.n]));
  return rows.results.map((r) => shapeStats({ ...r, stopped: stopMap.get(r.campaign as string) ?? 0 }));
}

export async function campaignStats(env: Env, campaign: string) {
  const isNone = campaign === '(none)';
  const cond = isNone ? 'campaign IS NULL' : 'campaign = ?';
  const binds = isNone ? [] : [campaign];
  const r = await env.DB.prepare(`${STATS_SQL} WHERE ${cond}`).bind(...binds).first<Record<string, number | string | null>>();
  if (!r || !Number(r.total)) throw new HttpError(404, `Campaign not found: ${campaign}`);
  const stops = await env.DB.prepare(
    `SELECT COUNT(DISTINCT r.from_email) AS n FROM replies r JOIN emails e ON e.id = r.email_id WHERE r.kind = 'stop' AND ${cond.replace('campaign', 'e.campaign')}`,
  )
    .bind(...binds)
    .first<{ n: number }>();
  const daily = await env.DB.prepare(
    `SELECT date(sent_at / 1000, 'unixepoch') AS day, COUNT(*) AS sent, SUM(open_count > 0) AS opened, SUM(reply_count > 0) AS replied
     FROM emails WHERE ${cond} AND sent_at IS NOT NULL GROUP BY 1 ORDER BY 1`,
  )
    .bind(...binds)
    .all();
  const cats = await env.DB.prepare(
    `SELECT COALESCE(r.category, '(uncategorized)') AS category, COUNT(*) AS n FROM replies r JOIN emails e ON e.id = r.email_id
     WHERE r.kind IN ('reply','stop') AND ${cond.replace('campaign', 'e.campaign')} GROUP BY 1 ORDER BY n DESC`,
  )
    .bind(...binds)
    .all<{ category: string; n: number }>();
  return { ...shapeStats({ ...r, campaign, stopped: stops?.n ?? 0 }), daily: daily.results, reply_categories: cats.results };
}

// ---------- Do-not-send ----------

/** The do-not-send scope of each of these addresses that is on the list. */
export async function dncScopes(env: Env, emails: string[]): Promise<Map<string, DncScope>> {
  const out = new Map<string, DncScope>();
  const uniq = [...new Set(emails.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 90) {
    const chunk = uniq.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT email, scope FROM dnc WHERE email IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ email: string; scope: DncScope }>();
    r.results.forEach((x) => out.set(x.email, x.scope));
  }
  return out;
}

/** Addresses a mailbox with this purpose must not email (purpose null: on the list at all). */
export async function dncLookup(env: Env, emails: string[], purpose: Purpose | null = null): Promise<Set<string>> {
  const scopes = await dncScopes(env, emails);
  return new Set([...scopes].filter(([, s]) => scopeBlocks(s, purpose)).map(([e]) => e));
}

export async function isDnc(env: Env, email: string, purpose: Purpose | null = null) {
  const r = await env.DB.prepare('SELECT scope FROM dnc WHERE email = ?').bind(normEmail(email)).first<{ scope: DncScope }>();
  return !!r && scopeBlocks(r.scope, purpose);
}

/**
 * Put addresses on the do-not-send list with a scope (which mailbox purposes it blocks). An address already
 * on the list keeps the wider scope. Queued emails it now blocks are skipped.
 */
export async function dncAdd(env: Env, emails: string[], reason: string | null, source: string, emailId: number | null = null, scope: DncScope = 'all') {
  const list = [...new Set(emails.map(normEmail).filter(isEmail))];
  if (!list.length) return { added: 0, cancelled: 0 };
  const sc = asHttp(() => checkScope(scope));
  const purposes = blockedPurposes(sc);
  const stmts: D1PreparedStatement[] = [];
  for (const e of list) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO dnc (email, reason, source, email_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET scope = excluded.scope, reason = excluded.reason, source = excluded.source, email_id = excluded.email_id
         WHERE ${scopeRankSql('excluded.scope')} > ${scopeRankSql('dnc.scope')}`,
      ).bind(e, reason, source, emailId, sc, now()),
    );
    stmts.push(
      env.DB.prepare(
        `UPDATE emails SET status = 'skipped', status_reason = 'do-not-send list'
         WHERE to_email = ? AND status = 'scheduled' AND mailbox_id IN (SELECT id FROM mailboxes WHERE purpose IN (${purposes.map(() => '?').join(',')}))`,
      ).bind(e, ...purposes),
    );
  }
  const res = await env.DB.batch(stmts);
  let added = 0;
  let cancelled = 0;
  res.forEach((r, i) => (i % 2 === 0 ? (added += r.meta.changes) : (cancelled += r.meta.changes)));
  return { added, cancelled, scope: sc };
}

export async function dncRemove(env: Env, emails: string[]) {
  const list = emails.map(normEmail).filter(Boolean);
  if (!list.length) return { removed: 0 };
  const r = await env.DB.prepare(`DELETE FROM dnc WHERE email IN (${list.map(() => '?').join(',')})`).bind(...list).run();
  return { removed: r.meta.changes };
}

export async function dncList(env: Env, f: { q?: string; scope?: string; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const conds: string[] = [];
  const b: unknown[] = [];
  if (f.q) (conds.push('email LIKE ?'), b.push(`%${normEmail(f.q)}%`));
  if (f.scope) (conds.push('scope = ?'), b.push(asHttp(() => checkScope(f.scope))));
  const w = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const [rows, total] = await Promise.all([
    env.DB.prepare(`SELECT * FROM dnc ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...b, limit, offset).all<{ email: string; reason: string; source: string; email_id: number; scope: string; created_at: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM dnc ${w}`).bind(...b).first<{ n: number }>(),
  ]);
  return { total: total?.n ?? 0, entries: rows.results.map((r) => ({ ...r, created_at: iso(r.created_at) })) };
}

export async function overview(env: Env) {
  const r = await env.DB.prepare(
    `SELECT SUM(status = 'scheduled') AS scheduled, SUM(status IN ('sent','bounced')) AS sent, SUM(status = 'failed') AS failed,
       SUM(open_count > 0) AS opened, SUM(reply_count > 0) AS replied,
       SUM(status = 'scheduled' AND send_at <= ?) AS due FROM emails`,
  )
    .bind(now())
    .first<Record<string, number>>();
  const dnc = await env.DB.prepare('SELECT COUNT(*) AS n FROM dnc').first<{ n: number }>();
  const pendingHooks = await env.DB.prepare("SELECT COUNT(*) AS n FROM replies WHERE webhook_status IN ('pending','failed')").first<{ n: number }>();
  const week = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM replies WHERE kind IN ('reply','stop') AND received_at >= ?) AS replies_7d,
            (SELECT COUNT(*) FROM emails WHERE sent_at >= ?) AS sent_24h`,
  )
    .bind(now() - 7 * 86_400_000, now() - 86_400_000)
    .first<{ replies_7d: number; sent_24h: number }>();
  return {
    scheduled: r?.scheduled || 0,
    due_now: r?.due || 0,
    sent: r?.sent || 0,
    failed: r?.failed || 0,
    opened: r?.opened || 0,
    replied: r?.replied || 0,
    do_not_send: dnc?.n || 0,
    webhooks_pending: pendingHooks?.n || 0,
    replies_7d: week?.replies_7d || 0,
    sent_24h: week?.sent_24h || 0,
  };
}
