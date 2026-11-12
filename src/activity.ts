import { contactVars, ContactRow, getContact } from './contacts';
import { Env, HttpError, isEmail, normEmail } from './util';

/**
 * Everything that happened with one address, newest first: every email sent or queued to it (from any
 * mailbox, sender, list send, series or group, with opens folded in), their replies, list joins, series
 * enrollments and stops, and do-not-send. Works for any address, saved as a contact or not.
 */

const MAX_EMAILS = 500;
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
const time = (t: string | null) => (t ? Date.parse(t) : 0);

type Event =
  | { type: 'email'; at: string; email: Record<string, unknown> }
  | { type: 'reply'; at: string; reply: Record<string, unknown> }
  | { type: 'contact_created'; at: string }
  | { type: 'list_joined'; at: string; list: string }
  | { type: 'series_enrolled'; at: string; series: { id: number; name: string } }
  | { type: 'series_stopped'; at: string; series: { id: number; name: string }; reason: string | null }
  | { type: 'do_not_send'; at: string; scope: string; reason: string | null; source: string | null };

export async function activity(env: Env, ref: string | number) {
  // A contact id, or any email address.
  let address: string;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const c = await env.DB.prepare('SELECT email FROM contacts WHERE id = ?').bind(Number(ref)).first<{ email: string }>();
    if (!c) throw new HttpError(404, `Contact ${ref} not found`);
    address = c.email;
  } else {
    address = normEmail(decodeURIComponent(String(ref)));
    if (!isEmail(address)) throw new HttpError(400, `Not an email address: ${ref}`);
  }

  const contactRow = await env.DB.prepare('SELECT * FROM contacts WHERE email = ?').bind(address).first<ContactRow>();
  const [emails, replies, joins, enrollments, dnc] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id, e.subject, e.status, e.status_reason, e.campaign, e.template_id, e.send_at, e.sent_at, e.open_count, e.first_opened_at, e.last_opened_at,
         e.reply_count, e.parent_email_id, e.from_name, e.from_email, e.to_name, e.mailbox_id, e.series_id, e.group_id,
         m.email AS mailbox, m.purpose, s.label AS sender_label, sr.name AS series_name, st.position AS series_step, g.name AS group_name
       FROM emails e JOIN mailboxes m ON m.id = e.mailbox_id
       LEFT JOIN senders s ON s.id = e.sender_id
       LEFT JOIN series sr ON sr.id = e.series_id
       LEFT JOIN series_steps st ON st.id = e.series_step_id
       LEFT JOIN mailbox_groups g ON g.id = e.group_id
       WHERE e.to_email = ? ORDER BY COALESCE(e.sent_at, e.send_at) DESC, e.id DESC LIMIT ?`,
    )
      .bind(address, MAX_EMAILS + 1)
      .all<Record<string, unknown> & { id: number; send_at: number; sent_at: number | null; first_opened_at: number | null; last_opened_at: number | null }>(),
    // Replies to emails sent to this address, and anything they sent in reply to someone else's email.
    env.DB.prepare(
      `SELECT r.id, r.email_id, r.from_email, r.from_name, r.subject, r.received_at, r.text, r.kind, r.category, r.category_source, r.webhook_status, e.subject AS email_subject
       FROM replies r JOIN emails e ON e.id = r.email_id
       WHERE e.to_email = ? OR r.from_email = ? ORDER BY r.received_at DESC LIMIT ?`,
    )
      .bind(address, address, MAX_EMAILS)
      .all<Record<string, unknown> & { received_at: number }>(),
    contactRow
      ? env.DB.prepare('SELECT l.name, lc.added_at FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = ?').bind(contactRow.id).all<{ name: string; added_at: number }>()
      : Promise.resolve({ results: [] as { name: string; added_at: number }[] }),
    contactRow
      ? env.DB.prepare(
          `SELECT en.*, s.name AS series_name,
             (SELECT COUNT(*) FROM series_steps st WHERE st.series_id = en.series_id) AS steps_total,
             (SELECT COUNT(*) FROM series_deliveries d JOIN series_steps st ON st.id = d.step_id WHERE d.enrollment_id = en.id) AS steps_done
           FROM series_enrollments en JOIN series s ON s.id = en.series_id WHERE en.contact_id = ?`,
        )
          .bind(contactRow.id)
          .all<{ series_id: number; series_name: string; status: string; stop_reason: string | null; waiting: number; enrolled_at: number; updated_at: number; steps_total: number; steps_done: number }>()
      : Promise.resolve({ results: [] as never[] }),
    env.DB.prepare('SELECT * FROM dnc WHERE email = ?').bind(address).first<{ scope: string; reason: string | null; source: string | null; created_at: number }>(),
  ]);

  const truncated = emails.results.length > MAX_EMAILS;
  const rows = emails.results.slice(0, MAX_EMAILS);
  const events: Event[] = [];
  for (const e of rows) {
    events.push({
      type: 'email',
      at: iso(e.sent_at ?? e.send_at)!,
      email: {
        id: e.id,
        subject: e.subject,
        status: e.status,
        status_reason: e.status_reason,
        mailbox: e.mailbox,
        purpose: e.purpose,
        from: e.from_email || e.mailbox,
        from_name: e.from_name,
        sender: e.sender_label ?? null,
        campaign: e.campaign,
        template_id: e.template_id,
        series: e.series_id ? { id: e.series_id, name: e.series_name ?? null, step: e.series_step ?? null } : null,
        group: e.group_id ? { id: e.group_id, name: e.group_name ?? null } : null,
        in_reply_to: e.parent_email_id ?? null,
        send_at: iso(e.send_at),
        sent_at: iso(e.sent_at),
        open_count: e.open_count,
        first_opened_at: iso(e.first_opened_at),
        last_opened_at: iso(e.last_opened_at),
        reply_count: e.reply_count,
      },
    });
  }
  for (const r of replies.results) {
    events.push({
      type: 'reply',
      at: iso(r.received_at)!,
      reply: {
        id: r.id,
        email_id: r.email_id,
        from: r.from_email,
        from_name: r.from_name,
        subject: r.subject,
        text: r.text,
        kind: r.kind,
        category: r.category,
        category_source: r.category_source,
        webhook_status: r.webhook_status,
        email_subject: r.email_subject,
      },
    });
  }
  if (contactRow) events.push({ type: 'contact_created', at: iso(contactRow.created_at)! });
  for (const j of joins.results) events.push({ type: 'list_joined', at: iso(j.added_at)!, list: j.name });
  for (const en of enrollments.results) {
    const series = { id: en.series_id, name: en.series_name };
    events.push({ type: 'series_enrolled', at: iso(en.enrolled_at)!, series });
    if (en.status === 'stopped') events.push({ type: 'series_stopped', at: iso(en.updated_at)!, series, reason: en.stop_reason });
  }
  if (dnc) events.push({ type: 'do_not_send', at: iso(dnc.created_at)!, scope: dnc.scope, reason: dnc.reason, source: dnc.source });
  // Newest first; at the same moment, put what happened later in the flow first.
  const order = { do_not_send: 0, series_stopped: 1, reply: 2, email: 3, series_enrolled: 4, list_joined: 5, contact_created: 6 } as const;
  events.sort((a, b) => time(b.at) - time(a.at) || order[a.type] - order[b.type]);

  const sent = rows.filter((e) => e.status === 'sent' || e.status === 'bounced');
  const human = replies.results.filter((r) => r.kind === 'reply' || r.kind === 'stop');
  const now = Date.now();
  const queued = rows.filter((e) => e.status === 'scheduled');
  return {
    email: address,
    contact: contactRow ? await getContact(env, contactRow.id).then(({ emails: _e, ...c }) => ({ ...c, vars: contactVars(contactRow) })) : null,
    summary: {
      emails: rows.length,
      sent: sent.length,
      scheduled: rows.filter((e) => e.status === 'scheduled' || e.status === 'sending').length,
      opened: sent.filter((e) => Number(e.open_count) > 0).length,
      replied: rows.filter((e) => Number(e.reply_count) > 0).length,
      replies: human.length,
      mailboxes: [...new Set(rows.map((e) => e.mailbox as string))],
      first_sent_at: iso(sent.length ? Math.min(...sent.map((e) => e.sent_at!)) : null),
      last_sent_at: iso(sent.length ? Math.max(...sent.map((e) => e.sent_at!)) : null),
      last_reply_at: iso(human.length ? Math.max(...human.map((r) => r.received_at)) : null),
      next_send_at: iso(queued.length ? Math.max(Math.min(...queued.map((e) => e.send_at)), now) : null),
      do_not_send: dnc ? { scope: dnc.scope, reason: dnc.reason, source: dnc.source, at: iso(dnc.created_at) } : null,
    },
    series: enrollments.results.map((en) => ({
      id: en.series_id,
      name: en.series_name,
      status: en.status,
      stop_reason: en.stop_reason,
      steps_done: en.steps_done,
      steps_total: en.steps_total,
      enrolled_at: iso(en.enrolled_at),
    })),
    events,
    truncated,
  };
}
