import { gmailApi, GmailError, MailboxRow } from './google';
import { buildMimeText, formatAddress, htmlToText, injectPixel, textToHtml } from './mime';
import { mailFormat, purposeOf, renderFooter } from './purpose';
import { dailyLimitAt } from './warmup';
import { prepareForSend } from './personalize';
import { sesSendRaw, SesError, trackedReplyAddress } from './ses';
import { LIMITS } from './planner';
import { EmailRow, getEmailRow, isConnected, isDnc, publicEmail, scheduleEmails, ScheduleInput } from './service';
import { b64urlEncodeStr, baseUrl, Env, now } from './util';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60_000;
// Cron ticks drift by a few seconds; don't push an email a whole extra minute for that.
const THROTTLE_TOLERANCE_MS = 30_000;

/** Send every scheduled email that is due. Called from the cron trigger (and "send now"). */
export async function processDue(env: Env, onlyIds?: number[]) {
  const batch = Math.max(1, Number(env.SEND_BATCH) || 20);
  // Anything stuck in "sending" for 10+ minutes was interrupted mid-send; we can't know if Gmail accepted it,
  // so mark failed rather than risk a duplicate.
  await env.DB.prepare(
    "UPDATE emails SET status = 'failed', status_reason = 'interrupted while sending (check Gmail Sent folder)' WHERE status = 'sending' AND claimed_at < ?",
  )
    .bind(now() - 10 * 60_000)
    .run();

  const due = onlyIds?.length
    ? await env.DB.prepare(`SELECT * FROM emails WHERE status = 'scheduled' AND id IN (${onlyIds.map(() => '?').join(',')})`).bind(...onlyIds).all<EmailRow>()
    : // A few of the oldest due emails per mailbox, so one busy mailbox can't crowd out the others.
      await env.DB.prepare(
        `SELECT * FROM (
           SELECT e.*, ROW_NUMBER() OVER (PARTITION BY mailbox_id ORDER BY send_at, id) AS rn
           FROM emails e WHERE status = 'scheduled' AND send_at <= ?
         ) WHERE rn <= 3 ORDER BY send_at, id LIMIT ?`,
      )
        .bind(now(), batch)
        .all<EmailRow>();
  if (!due.results.length) return { sent: 0, failed: 0, skipped: 0, deferred: 0 };

  const base = await baseUrl(env);
  const mailboxes = new Map<number, MailboxRow | null>();
  const sentToday = new Map<number, number>();
  const lastSent = new Map<number, number>();
  const held = new Set<number>(); // mailboxes already at a limit this tick
  const stats = { sent: 0, failed: 0, skipped: 0, deferred: 0 };

  for (const e of due.results) {
    let mb = mailboxes.get(e.mailbox_id);
    if (mb === undefined) {
      mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(e.mailbox_id).first<MailboxRow>();
      mailboxes.set(e.mailbox_id, mb);
    }
    if (!mb || !mb.active || !isConnected(mb)) {
      await setStatus(env, e.id, 'failed', 'mailbox inactive or disconnected');
      stats.failed++;
      continue;
    }
    if (await isDnc(env, e.to_email, purposeOf(mb))) {
      await setStatus(env, e.id, 'skipped', 'do-not-send list');
      stats.skipped++;
      continue;
    }
    if (held.has(mb.id)) {
      stats.deferred++;
      continue;
    }
    if (!sentToday.has(mb.id)) {
      const c = await env.DB.prepare(
        "SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM emails WHERE mailbox_id = ? AND sent_at >= ? AND status IN ('sent','bounced','sending')",
      )
        .bind(mb.id, now() - LIMITS.WINDOW_MS)
        .first<{ n: number; last: number | null }>();
      sentToday.set(mb.id, c?.n ?? 0);
      lastSent.set(mb.id, c?.last ?? 0);
    }
    // Daily limit (rolling 24h). The email stays scheduled and goes out once the window frees up.
    // Warming up: today's limit, which grows each day until it reaches the daily limit.
    const limit = Math.max(1, mb.daily_limit ? dailyLimitAt(mb, now()) : LIMITS.DEFAULT_DAILY_LIMIT);
    if (sentToday.get(mb.id)! >= limit) {
      await holdEmail(env, e, mb.warmup_enabled && limit < mb.daily_limit ? `waiting: warm-up limit of ${limit} today` : `waiting: daily limit of ${limit} reached`);
      held.add(mb.id);
      stats.deferred++;
      continue;
    }
    // Throttle: minimum gap between sends from this mailbox. "Send now" (explicit ids) skips it.
    const gapMs = Math.max(1, mb.throttle_minutes || LIMITS.DEFAULT_THROTTLE_MINUTES) * 60_000;
    if (!onlyIds?.length && now() - (lastSent.get(mb.id) || 0) < gapMs - THROTTLE_TOLERANCE_MS) {
      await holdEmail(env, e, `waiting: throttle (1 email every ${mb.throttle_minutes} min)`);
      held.add(mb.id);
      stats.deferred++;
      continue;
    }
    // Claim the row so overlapping cron runs never double-send.
    const claim = await env.DB.prepare("UPDATE emails SET status = 'sending', attempts = attempts + 1, claimed_at = ? WHERE id = ? AND status = 'scheduled'").bind(now(), e.id).run();
    if (!claim.meta.changes) continue;

    try {
      // AI personalization (templates that ask for it): rewrite now, or skip, or try again later.
      const prep = await prepareForSend(env, e, e.attempts + 1 >= MAX_ATTEMPTS);
      if (prep.action !== 'send') {
        if (prep.action === 'retry') {
          await env.DB.prepare("UPDATE emails SET status = 'scheduled', status_reason = ?, send_at = ? WHERE id = ?").bind(`retrying: ${prep.reason}`.slice(0, 300), now() + RETRY_DELAY_MS, e.id).run();
        }
        if (prep.action === 'fail') await setStatus(env, e.id, 'failed', prep.reason.slice(0, 500));
        if (prep.action === 'skip') stats.skipped++;
        else stats.failed++;
        continue;
      }
      const em = prep.email;
      const thread = await threadInfo(env, em);
      const raw = composeRaw(em, mb, base, thread);
      if (mb.provider === 'ses') {
        const sesId = await sesSendRaw(mb, raw.mime);
        await env.DB.prepare("UPDATE emails SET status = 'sent', status_reason = NULL, sent_at = ?, ses_message_id = ?, message_id_header = ? WHERE id = ?")
          .bind(now(), sesId, raw.messageId, e.id)
          .run();
      } else {
        const res = await gmailApi.send(env, mb, raw.raw, thread?.threadId);
        await env.DB.prepare(
          "UPDATE emails SET status = 'sent', status_reason = NULL, sent_at = ?, gmail_message_id = ?, gmail_thread_id = ?, message_id_header = ? WHERE id = ?",
        )
          .bind(now(), res.id, res.threadId, raw.messageId, e.id)
          .run();
      }
      sentToday.set(mb.id, (sentToday.get(mb.id) ?? 0) + 1);
      lastSent.set(mb.id, now());
      stats.sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const authProblem =
        /invalid_grant|unauthorized_client/.test(msg) ||
        (err instanceof GmailError && err.status === 401) ||
        (err instanceof SesError && (err.status === 403 || /InvalidClientTokenId|SignatureDoesNotMatch|AccessDenied/i.test(msg)));
      if (authProblem) {
        await env.DB.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').bind(`Auth failed, reconnect mailbox: ${msg.slice(0, 300)}`, mb.id).run();
      }
      const permanent = (err instanceof GmailError || err instanceof SesError) && err.status === 400;
      if (!permanent && !authProblem && e.attempts + 1 < MAX_ATTEMPTS) {
        await env.DB.prepare("UPDATE emails SET status = 'scheduled', status_reason = ?, send_at = ? WHERE id = ?")
          .bind(`retrying: ${msg.slice(0, 300)}`, now() + RETRY_DELAY_MS, e.id)
          .run();
      } else {
        await setStatus(env, e.id, 'failed', msg.slice(0, 500));
      }
      stats.failed++;
    }
  }
  return stats;
}

/** Leave the email scheduled but say why it hasn't gone yet (shown in the UI). */
async function holdEmail(env: Env, e: EmailRow, reason: string) {
  if (e.status_reason === reason) return;
  await env.DB.prepare("UPDATE emails SET status_reason = ? WHERE id = ? AND status = 'scheduled'").bind(reason, e.id).run();
}

async function setStatus(env: Env, id: number, status: string, reason: string | null) {
  await env.DB.prepare('UPDATE emails SET status = ?, status_reason = ? WHERE id = ?').bind(status, reason, id).run();
}

/** From / Reply-To for an email: the email's own values, else the mailbox defaults, else the mailbox itself. */
export function senderIdentity(e: EmailRow, mb: MailboxRow) {
  const fromEmail = e.from_email || mb.from_email || mb.email;
  let aliasName: string | null = null;
  try {
    aliasName = (JSON.parse(mb.send_as || '[]') as { email: string; name: string | null }[]).find((a) => a.email === fromEmail)?.name ?? null;
  } catch {
    /* ignore */
  }
  return {
    fromEmail,
    fromName: e.from_name || mb.name || aliasName,
    replyTo: e.reply_to || mb.reply_to || null,
  };
}

export interface ThreadInfo {
  inReplyTo: string | null;
  references: string | null;
  threadId: string | null;
}

const angle = (id: string) => (id.trim().startsWith('<') ? id.trim() : `<${id.trim()}>`);

/** For a reply: the Message-IDs of the conversation so far (ours and theirs), and the Gmail thread. */
export async function threadInfo(env: Env, e: Pick<EmailRow, 'parent_email_id'>): Promise<ThreadInfo | null> {
  if (!e.parent_email_id) return null;
  const chain: EmailRow[] = [];
  let id: number | null = e.parent_email_id;
  for (let i = 0; id && i < 20; i++) {
    const p: EmailRow | null = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first<EmailRow>();
    if (!p) break;
    chain.unshift(p);
    id = p.parent_email_id;
  }
  if (!chain.length) return null;
  const ids: string[] = [];
  for (const p of chain) {
    if (p.message_id_header) ids.push(angle(p.message_id_header));
    const rs = await env.DB.prepare('SELECT message_id_header FROM replies WHERE email_id = ? AND message_id_header IS NOT NULL ORDER BY received_at')
      .bind(p.id)
      .all<{ message_id_header: string }>();
    ids.push(...rs.results.map((r) => angle(r.message_id_header)));
  }
  const uniq = [...new Set(ids)];
  return {
    inReplyTo: uniq.at(-1) ?? null,
    references: uniq.length ? uniq.slice(-20).join(' ') : null,
    threadId: chain.at(-1)!.gmail_thread_id,
  };
}

/** Put a block at the end of an HTML body (inside <body> when there is one). */
function appendHtml(html: string, block: string) {
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i >= 0 ? html.slice(0, i) + block + html.slice(i) : html + block;
}

/**
 * The raw message. How it's built depends on the mailbox purpose (see purpose.ts): cold outreach looks like a
 * personal email (no pixel, no List-Unsubscribe), newsletters get tracking, one-click unsubscribe and list headers,
 * conversations stay plain. A footer, if any, goes at the end; replies carry In-Reply-To/References.
 */
export function composeRaw(e: EmailRow, mb: MailboxRow, base: string, thread: ThreadInfo | null = null) {
  const fmt = mailFormat(mb);
  const id = senderIdentity(e, mb);
  const { fromEmail, fromName } = id;
  // SES has no inbox: replies come back through a tracked address on the reply domain (Cloudflare Email Routing).
  const tracked = mb.provider === 'ses' ? trackedReplyAddress(mb, e.track_token) : null;
  const replyTo = id.replyTo || tracked;
  const domain = fromEmail.split('@')[1] || 'outbound.local';
  const messageId = `<${e.track_token}.${Date.now().toString(36)}@${domain}>`;
  const pixel = `${base}/t/${e.track_token}.gif`;
  const unsub = `${base}/u/${e.track_token}`;
  let html = e.body_html || textToHtml(e.body_text || '');
  let text = e.body_text || htmlToText(e.body_html || '');
  const footer = renderFooter(fmt.footer, unsub);
  if (footer) {
    html = appendHtml(html, footer.html);
    text = `${text.replace(/\s+$/, '')}\n\n${footer.text}`;
  }
  if (fmt.track_opens) html = injectPixel(html, pixel);
  const mime = buildMimeText({
    from: formatAddress(fromEmail, fromName),
    to: formatAddress(e.to_email, e.to_name),
    subject: e.subject,
    html,
    text,
    headers: {
      'Message-ID': messageId,
      Date: new Date().toUTCString().replace('GMT', '+0000'),
      ...(thread?.inReplyTo ? { 'In-Reply-To': thread.inReplyTo, References: thread.references || thread.inReplyTo } : {}),
      ...(fmt.list_unsubscribe
        ? { 'List-Unsubscribe': `<${unsub}>, <mailto:${tracked || mb.email}?subject=STOP>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : {}),
      ...(fmt.bulk_headers ? { 'List-Id': `<mailbox-${mb.id}.${domain}>`, Precedence: 'bulk' } : {}),
      ...(replyTo ? { 'Reply-To': replyTo } : {}),
    },
  });
  return { raw: b64urlEncodeStr(mime), mime, messageId };
}

/**
 * Reply to one of our sent emails in the same thread, sent right away (or at send_at). Defaults come from the
 * email being answered: whoever last replied, "Re: <subject>", the same mailbox, sender, From and Reply-To.
 */
export async function sendReply(env: Env, emailId: number, d: Omit<ScheduleInput, 'in_reply_to'> & { send_at?: string | number }) {
  const r = await scheduleEmails(env, [{ ...d, to: d.to || '', in_reply_to: emailId } as ScheduleInput]);
  if (!r.scheduled.length) return { sent: false, skipped: r.skipped };
  const id = r.scheduled[0].id;
  if (d.send_at) return { sent: false, scheduled: r.scheduled[0] };
  const result = await processDue(env, [id]);
  const e = await getEmailRow(env, id);
  return { sent: e.status === 'sent', email: publicEmail(e), result };
}
