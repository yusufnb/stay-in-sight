import PostalMime from 'postal-mime';
import type { MailboxRow } from './google';
import { bodiesText, classifyHeaders } from './parse';
import type { EmailRow } from './service';
import { deliverWebhooks, recordReply } from './sync';
import { Env, now, randomToken } from './util';

/** reply+<track_token>@<reply domain>: the address SES emails ask people to reply to. */
const REPLY_ADDRESS = /^reply\+([A-Za-z0-9_-]{8,64})@([a-z0-9.-]+)$/i;

/**
 * Cloudflare Email Routing hands every message for the reply domain to this Worker. Messages to a
 * tracked reply address are recorded as replies to that email (STOP, categories, webhooks as usual)
 * and optionally forwarded to a human inbox; anything else is rejected.
 */
export async function handleInboundEmail(env: Env, message: ForwardableEmailMessage, ctx: ExecutionContext) {
  const m = REPLY_ADDRESS.exec(message.to.trim());
  if (!m) return message.setReject('Unknown address');
  const email = await env.DB.prepare('SELECT * FROM emails WHERE track_token = ?').bind(m[1]).first<EmailRow>();
  if (!email) return message.setReject('Unknown address');
  const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(email.mailbox_id).first<MailboxRow>();
  if (!mb || (mb.reply_domain && mb.reply_domain.toLowerCase() !== m[2].toLowerCase())) return message.setReject('Unknown address');

  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw);
  const headers = new Map<string, string>();
  for (const h of parsed.headers || []) if (!headers.has(h.key.toLowerCase())) headers.set(h.key.toLowerCase(), h.value);
  const get = (n: string) => headers.get(n.toLowerCase()) || '';
  const fromEmail = (parsed.from?.address || message.from || '').toLowerCase();
  const subject = parsed.subject || '';
  const { full, latest } = bodiesText(parsed.text || '', parsed.html || '');

  await recordReply(env, mb, email, {
    key: `mail:${parsed.messageId || randomToken()}`,
    threadId: null,
    from: { email: fromEmail, name: parsed.from?.name || null },
    subject,
    receivedAt: now(),
    full,
    latest,
    kind: classifyHeaders(get, get('content-type'), fromEmail),
    messageIdHeader: parsed.messageId || get('message-id') || null,
  });

  if (mb.forward_to) {
    try {
      await message.forward(mb.forward_to);
    } catch (err) {
      // The address must be a verified destination in Cloudflare Email Routing.
      await env.DB.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?')
        .bind(`Couldn't forward a reply to ${mb.forward_to}: ${(err as Error).message}. Verify it under Email Routing → Destination addresses.`.slice(0, 500), mb.id)
        .run();
    }
  }
  ctx.waitUntil(deliverWebhooks(env).then(() => undefined));
}
