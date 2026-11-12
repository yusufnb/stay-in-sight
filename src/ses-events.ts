import { dncAdd } from './service';
import { isSnsUrl, SnsMessage, verifySnsMessage } from './sns';
import { Env, setSetting } from './util';

interface SesEvent {
  eventType?: string; // event publishing (configuration sets)
  notificationType?: string; // identity notifications
  mail?: { messageId?: string; destination?: string[] };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress: string }[]; complaintFeedbackType?: string };
  reject?: { reason?: string };
  deliveryDelay?: { delayType?: string; delayedRecipients?: { emailAddress: string }[] };
}

/**
 * SES bounce / complaint / delivery events, delivered by SNS. Verifies the SNS signature, confirms the
 * subscription on first contact, then: hard bounce → email marked bounced + address on do-not-send;
 * complaint → do-not-send; reject/delay → noted on the email.
 */
export async function handleSesWebhook(env: Env, msg: SnsMessage): Promise<{ status: number; result: Record<string, unknown> }> {
  if (!(await verifySnsMessage(msg))) return { status: 403, result: { error: 'Signature check failed' } };

  if (msg.Type === 'SubscriptionConfirmation') {
    if (!isSnsUrl(msg.SubscribeURL)) return { status: 400, result: { error: 'Bad SubscribeURL' } };
    const res = await fetch(msg.SubscribeURL!);
    await setSetting(env, 'ses_sns', JSON.stringify({ topic: msg.TopicArn, confirmed_at: new Date().toISOString(), ok: res.ok }));
    return { status: res.ok ? 200 : 502, result: { confirmed: res.ok, topic: msg.TopicArn } };
  }
  if (msg.Type !== 'Notification') return { status: 200, result: { ignored: msg.Type } };

  let ev: SesEvent;
  try {
    ev = JSON.parse(msg.Message);
  } catch {
    return { status: 200, result: { ignored: 'not JSON' } };
  }
  const type = (ev.eventType || ev.notificationType || '').toLowerCase();
  const sesId = ev.mail?.messageId || '';
  const email = sesId ? await env.DB.prepare('SELECT id, status FROM emails WHERE ses_message_id = ?').bind(sesId).first<{ id: number; status: string }>() : null;
  const note = (reason: string, status?: string) =>
    email
      ? env.DB.prepare(`UPDATE emails SET ${status ? 'status = ?, ' : ''}status_reason = ? WHERE id = ?`)
          .bind(...(status ? [status] : []), reason.slice(0, 300), email.id)
          .run()
      : Promise.resolve();

  await setSetting(env, 'ses_last_event', JSON.stringify({ type, at: new Date().toISOString() }));

  if (type === 'bounce') {
    const recips = ev.bounce?.bouncedRecipients || [];
    const diag = recips.map((r) => r.diagnosticCode).filter(Boolean)[0] || ev.bounce?.bounceSubType || '';
    if (ev.bounce?.bounceType === 'Permanent') {
      await note(`hard bounce: ${diag}`, 'bounced');
      await dncAdd(env, recips.map((r) => r.emailAddress), `Hard bounce${diag ? `: ${diag}` : ''}`.slice(0, 200), 'bounce', email?.id ?? null);
      return { status: 200, result: { handled: 'hard bounce', recipients: recips.length } };
    }
    await note(`soft bounce (${ev.bounce?.bounceType || 'unknown'}): ${diag}`);
    return { status: 200, result: { handled: 'soft bounce' } };
  }
  if (type === 'complaint') {
    const recips = ev.complaint?.complainedRecipients || [];
    await note('complaint: the recipient marked this as spam');
    await dncAdd(env, recips.map((r) => r.emailAddress), `Complaint (marked as spam)${ev.complaint?.complaintFeedbackType ? `: ${ev.complaint.complaintFeedbackType}` : ''}`, 'complaint', email?.id ?? null);
    return { status: 200, result: { handled: 'complaint', recipients: recips.length } };
  }
  if (type === 'reject') {
    await note(`rejected by SES: ${ev.reject?.reason || ''}`, 'failed');
    return { status: 200, result: { handled: 'reject' } };
  }
  if (type === 'deliverydelay') {
    await note(`delivery delayed: ${ev.deliveryDelay?.delayType || ''}`);
    return { status: 200, result: { handled: 'delay' } };
  }
  return { status: 200, result: { ignored: type || 'unknown' } };
}
