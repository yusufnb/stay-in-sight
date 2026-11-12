import { gmailApi, GmailError, MailboxRow } from './google';
import { categorize, CategorizeInput, CategorizeResult, categoryRows, STOP } from './categorize';
import { htmlToText } from './mime';
import { classify, header, isStop, messageText, parseAddress } from './parse';
import { dncAdd, EmailRow, ReplyRow, storedConversation, threadConversation } from './service';
import { optOutScope, purposeOf } from './purpose';
import { Env, hmacHex, HttpError, now } from './util';

const WEBHOOK_MAX_ATTEMPTS = 6;

/** Pull new inbox messages since the stored history cursor and record replies to our threads. */
export async function syncMailbox(env: Env, mb: MailboxRow) {
  if (!mb.active || !mb.refresh_token || mb.provider === 'ses') return { processed: 0 };
  let processed = 0;
  try {
    if (!mb.history_id) {
      const p = await gmailApi.profile(env, mb);
      await env.DB.prepare('UPDATE mailboxes SET history_id = ?, last_sync_at = ?, last_error = NULL WHERE id = ?').bind(p.historyId, now(), mb.id).run();
      return { processed };
    }
    let pageToken: string | undefined;
    let latest = mb.history_id;
    const seen = new Set<string>();
    do {
      let page;
      try {
        page = await gmailApi.history(env, mb, mb.history_id, pageToken);
      } catch (err) {
        if (err instanceof GmailError && err.status === 404) {
          // Cursor too old (>~1 week). Reset; replies in the gap are missed.
          const p = await gmailApi.profile(env, mb);
          await env.DB.prepare('UPDATE mailboxes SET history_id = ?, last_error = ? WHERE id = ?')
            .bind(p.historyId, 'History cursor expired; reset (replies during the gap may be missed)', mb.id)
            .run();
          return { processed };
        }
        throw err;
      }
      latest = page.historyId || latest;
      for (const h of page.history || []) {
        for (const added of h.messagesAdded || []) {
          const m = added.message;
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          const labels = m.labelIds || [];
          if (labels.includes('SENT') || labels.includes('DRAFT')) continue;
          if (await handleIncoming(env, mb, m.id, m.threadId)) processed++;
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    await env.DB.prepare('UPDATE mailboxes SET history_id = ?, last_sync_at = ?, last_error = NULL WHERE id = ?').bind(latest, now(), mb.id).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE mailboxes SET last_error = ?, last_sync_at = ? WHERE id = ?').bind(msg.slice(0, 500), now(), mb.id).run();
    console.error('sync failed', mb.email, msg);
  }
  return { processed };
}

/** Returns true if the message was a reply to one of our emails and was recorded. */
async function handleIncoming(env: Env, mb: MailboxRow, messageId: string, threadId: string): Promise<boolean> {
  // Cheap filter first: only threads we started.
  const email = await env.DB.prepare('SELECT * FROM emails WHERE mailbox_id = ? AND gmail_thread_id = ? ORDER BY sent_at DESC LIMIT 1')
    .bind(mb.id, threadId)
    .first<EmailRow>();
  if (!email) return false;
  const exists = await env.DB.prepare('SELECT 1 FROM replies WHERE gmail_message_id = ?').bind(messageId).first();
  if (exists) return false;

  const msg = await gmailApi.getMessage(env, mb, messageId);
  const { full, latest } = messageText(msg);
  return recordReply(env, mb, email, {
    key: messageId,
    threadId,
    from: parseAddress(header(msg, 'from')),
    subject: header(msg, 'subject'),
    receivedAt: msg.internalDate ? Number(msg.internalDate) : now(),
    full,
    latest,
    kind: classify(msg),
    messageIdHeader: header(msg, 'message-id') || null,
  });
}

/** An incoming message, from Gmail or email routing, already parsed. */
export interface InboundMessage {
  key: string; // unique per message (Gmail id, or mail:<Message-ID>)
  threadId: string | null;
  from: { email: string; name: string | null };
  subject: string;
  receivedAt: number;
  full: string;
  latest: string;
  kind: 'reply' | 'auto' | 'bounce';
  /** The Message-ID header, so answers can be threaded under it. */
  messageIdHeader?: string | null;
}

/** Record a reply to one of our emails: category, STOP → do-not-send, counters, webhook queue. */
export async function recordReply(env: Env, mb: MailboxRow, email: EmailRow, m: InboundMessage): Promise<boolean> {
  // Messages we sent (from the mailbox or any of its aliases) aren't replies.
  const own = new Set([mb.email, mb.from_email, email.from_email, ...((JSON.parse(mb.send_as || '[]') as { email: string }[]).map((a) => a.email))].filter(Boolean));
  if (own.has(m.from.email)) return false;
  if (await env.DB.prepare('SELECT 1 FROM replies WHERE gmail_message_id = ?').bind(m.key).first()) return false;
  const { from, subject, full, latest, receivedAt } = m;
  const messageId = m.key;
  const threadId = m.threadId;
  let kind: string = m.kind;

  // Category: a literal STOP needs no model; other human replies go to the LLM categorizer.
  let cat: CategorizeResult = { category: null, source: null, cost: null, error: null };
  if (kind === 'reply' && isStop(latest, subject)) cat = { category: STOP, source: 'rule', cost: null, error: null };
  else if (kind === 'reply' && env.OPENROUTER_API_KEY) cat = await categorize(env, categorizeInput(email, latest, subject));
  if (cat.category === STOP) kind = 'stop';

  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO replies (email_id, mailbox_id, gmail_message_id, gmail_thread_id, from_email, from_name, subject, received_at, text, full_text, kind, webhook_status,
       category, category_source, category_error, category_cost, message_id_header, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      email.id,
      mb.id,
      messageId,
      threadId,
      from.email,
      from.name,
      subject,
      receivedAt,
      latest,
      full.slice(0, 100_000),
      kind,
      kind === 'auto' || kind === 'bounce' ? 'skipped' : mb.webhook_url ? 'pending' : 'none',
      cat.category,
      cat.source,
      cat.error,
      cat.cost,
      m.messageIdHeader || null,
      now(),
    )
    .run();
  if (!ins.meta.changes) return false;

  if (kind === 'bounce') {
    await env.DB.prepare("UPDATE emails SET status = 'bounced', status_reason = ? WHERE id = ?").bind(latest.slice(0, 300) || 'bounced', email.id).run();
  } else if (kind !== 'auto') {
    await env.DB.prepare('UPDATE emails SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?').bind(receivedAt, email.id).run();
  }
  if (kind === 'stop') {
    // A STOP to cold outreach blocks outreach and newsletters; to a newsletter, newsletters; in a conversation, everything.
    await dncAdd(env, [from.email, email.to_email], `Replied (${cat.source === 'ai' ? 'categorized as stop' : 'STOP'}): ${latest.slice(0, 100)}`, 'reply', email.id, optOutScope(purposeOf(mb)));
  }
  return true;
}

function categorizeInput(email: EmailRow, reply: string, replySubject: string): CategorizeInput {
  return { reply, reply_subject: replySubject, original_subject: email.subject, original_body: email.body_text || htmlToText(email.body_html || '') };
}

/**
 * Set a reply's category. Moving a reply to "stop" adds the sender to do-not-send and makes it a STOP reply.
 * Moving it away from "stop" does not remove anyone from do-not-send (do that on the Do-not-send page).
 */
export async function applyCategory(env: Env, replyId: number, category: string | null, source: string, extra: { cost?: number | null; error?: string | null } = {}) {
  const r = await env.DB.prepare('SELECT * FROM replies WHERE id = ?').bind(replyId).first<ReplyRow>();
  if (!r) throw new HttpError(404, `Reply ${replyId} not found`);
  if (r.kind === 'auto' || r.kind === 'bounce') throw new HttpError(400, `This is ${r.kind === 'auto' ? 'an auto-reply' : 'a bounce'}, so it isn't categorized`);
  if (category) {
    const exists = await env.DB.prepare('SELECT 1 FROM categories WHERE name = ?').bind(category).first();
    if (!exists) throw new HttpError(400, `Unknown category: ${category}`);
  }
  const kind = category === STOP ? 'stop' : r.kind === 'stop' && category ? 'reply' : r.kind;
  await env.DB.prepare(
    'UPDATE replies SET category = ?, category_source = ?, category_error = ?, category_cost = COALESCE(?, category_cost), kind = ? WHERE id = ?',
  )
    .bind(category, category ? source : null, extra.error ?? null, extra.cost ?? null, kind, replyId)
    .run();
  if (category === STOP && r.kind !== 'stop') {
    const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(r.email_id).first<EmailRow>();
    const mb = await env.DB.prepare('SELECT purpose FROM mailboxes WHERE id = ?').bind(r.mailbox_id).first<{ purpose: string }>();
    await dncAdd(env, [r.from_email || '', email?.to_email || ''], `Reply categorized as stop: ${(r.text || '').slice(0, 100)}`, 'reply', r.email_id, optOutScope(purposeOf({ purpose: mb?.purpose || 'outreach' })));
  }
  return (await env.DB.prepare('SELECT * FROM replies WHERE id = ?').bind(replyId).first<ReplyRow>())!;
}

/** Run the LLM categorizer again for a stored reply. */
export async function recategorize(env: Env, replyId: number) {
  const r = await env.DB.prepare('SELECT * FROM replies WHERE id = ?').bind(replyId).first<ReplyRow>();
  if (!r) throw new HttpError(404, `Reply ${replyId} not found`);
  const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(r.email_id).first<EmailRow>();
  const res = await categorize(env, categorizeInput(email!, r.text || '', r.subject || ''));
  if (!res.category) {
    await env.DB.prepare('UPDATE replies SET category_error = ?, category_cost = COALESCE(?, category_cost) WHERE id = ?').bind(res.error, res.cost, replyId).run();
    return { reply: (await env.DB.prepare('SELECT * FROM replies WHERE id = ?').bind(replyId).first<ReplyRow>())!, result: res };
  }
  return { reply: await applyCategory(env, replyId, res.category, 'ai', { cost: res.cost }), result: res };
}

export async function syncAll(env: Env) {
  const mbs = (await env.DB.prepare("SELECT * FROM mailboxes WHERE active = 1 AND refresh_token != '' AND provider = 'google'").all<MailboxRow>()).results;
  let processed = 0;
  for (const mb of mbs) processed += (await syncMailbox(env, mb)).processed;
  return { mailboxes: mbs.length, processed };
}

/** Called by the Gmail Pub/Sub push subscription. */
export async function handlePush(env: Env, body: { message?: { data?: string } }) {
  let emailAddress: string | undefined;
  try {
    const decoded = JSON.parse(atob(body.message?.data || '')) as { emailAddress?: string };
    emailAddress = decoded.emailAddress?.toLowerCase();
  } catch {
    /* ignore malformed */
  }
  if (!emailAddress) return { ok: true, ignored: true };
  const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE email = ?').bind(emailAddress).first<MailboxRow>();
  if (!mb) return { ok: true, ignored: true };
  const r = await syncMailbox(env, mb);
  await deliverWebhooks(env);
  return { ok: true, ...r };
}

/** Renew Gmail push watches (they expire after 7 days). */
export async function renewWatches(env: Env, force = false) {
  if (!env.GMAIL_PUBSUB_TOPIC) return { renewed: 0 };
  const mbs = (
    await env.DB.prepare("SELECT * FROM mailboxes WHERE active = 1 AND refresh_token != '' AND provider = 'google' AND (? OR watch_expires_at IS NULL OR watch_expires_at < ?)")
      .bind(force ? 1 : 0, now() + 24 * 3600_000)
      .all<MailboxRow>()
  ).results;
  let renewed = 0;
  for (const mb of mbs) {
    try {
      const w = await gmailApi.watch(env, mb, env.GMAIL_PUBSUB_TOPIC);
      await env.DB.prepare('UPDATE mailboxes SET watch_expires_at = ?, history_id = COALESCE(history_id, ?) WHERE id = ?').bind(Number(w.expiration), w.historyId, mb.id).run();
      renewed++;
    } catch (err) {
      await env.DB.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').bind(`watch: ${(err as Error).message.slice(0, 400)}`, mb.id).run();
    }
  }
  return { renewed };
}

// ---------- Reply webhooks ----------

export async function buildWebhookPayload(env: Env, reply: ReplyRow, email: EmailRow, mb: MailboxRow) {
  const catDesc = new Map((await categoryRows(env)).map((c) => [c.name, c.description]));
  let conversation: Awaited<ReturnType<typeof threadConversation>> = [];
  if (mb.provider !== 'ses' && email.gmail_thread_id) {
    try {
      conversation = await threadConversation(env, mb, email.gmail_thread_id);
    } catch (err) {
      console.error('conversation fetch failed; falling back to stored messages', (err as Error).message);
    }
  }
  if (!conversation.length) conversation = await storedConversation(env, email, mb);
  return {
    event: reply.kind === 'stop' ? 'reply.stop' : 'reply.received',
    mailbox: mb.email,
    campaign: email.campaign,
    email: {
      id: email.id,
      to: email.to_email,
      to_name: email.to_name,
      subject: email.subject,
      sent_at: email.sent_at ? new Date(email.sent_at).toISOString() : null,
      open_count: email.open_count,
      metadata: email.metadata ? JSON.parse(email.metadata) : null,
    },
    reply: {
      id: reply.id,
      from: reply.from_email,
      from_name: reply.from_name,
      subject: reply.subject,
      received_at: new Date(reply.received_at).toISOString(),
      text: reply.text,
      is_stop: reply.kind === 'stop',
      category: reply.category ? { name: reply.category, description: catDesc.get(reply.category) ?? null } : null,
      category_source: reply.category_source, // ai | rule | manual
    },
    thread_id: email.gmail_thread_id,
    conversation,
  };
}

/** POST pending/failed replies to their mailbox's webhook with exponential backoff. */
export async function deliverWebhooks(env: Env, onlyReplyId?: number) {
  const rows = onlyReplyId
    ? await env.DB.prepare('SELECT * FROM replies WHERE id = ?').bind(onlyReplyId).all<ReplyRow & { updated?: number }>()
    : await env.DB.prepare("SELECT * FROM replies WHERE webhook_status IN ('pending','failed') AND webhook_attempts < ? ORDER BY id LIMIT 20")
        .bind(WEBHOOK_MAX_ATTEMPTS)
        .all<ReplyRow>();
  let delivered = 0;
  for (const r of rows.results) {
    // backoff: attempt n waits 2^n minutes after the reply was recorded
    if (!onlyReplyId && r.webhook_attempts > 0 && now() - r.created_at < 2 ** r.webhook_attempts * 60_000) continue;
    const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(r.email_id).first<EmailRow>();
    const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(r.mailbox_id).first<MailboxRow>();
    if (!email || !mb || !mb.webhook_url) {
      await env.DB.prepare("UPDATE replies SET webhook_status = 'none' WHERE id = ?").bind(r.id).run();
      continue;
    }
    // If the categorizer failed when the reply arrived, give it one more try before forwarding.
    let reply = r;
    if (reply.kind === 'reply' && !reply.category && reply.category_error && env.OPENROUTER_API_KEY) {
      reply = (await recategorize(env, reply.id)).reply;
    }
    const payload = JSON.stringify(await buildWebhookPayload(env, reply, email, mb));
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'cms-outbound/1.0', 'x-outbound-event': reply.kind };
    if (reply.category) headers['x-outbound-category'] = reply.category;
    if (mb.webhook_secret) headers['x-outbound-signature'] = `sha256=${await hmacHex(mb.webhook_secret, payload)}`;
    let status = 'failed';
    let response = '';
    try {
      const res = await fetch(mb.webhook_url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(15_000) });
      response = `${res.status} ${(await res.text()).slice(0, 300)}`;
      if (res.ok) status = 'delivered';
    } catch (err) {
      response = (err as Error).message.slice(0, 300);
    }
    await env.DB.prepare('UPDATE replies SET webhook_status = ?, webhook_attempts = webhook_attempts + 1, webhook_response = ? WHERE id = ?')
      .bind(status, response, r.id)
      .run();
    if (status === 'delivered') delivered++;
  }
  return { delivered, attempted: rows.results.length };
}
