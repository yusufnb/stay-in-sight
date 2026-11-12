import { aiConfig } from './categorize';
import { contactVars, ContactRow } from './contacts';
import type { EmailRow } from './service';
import { getTemplateRow, isHtml, normTemplateId, TemplateRow } from './templates';
import { Env, HttpError, normEmail, now } from './util';

/**
 * AI personalization: just before an email from an AI-enabled template is sent, a model rewrites it
 * for its recipient, following the template's instructions and using the contact's data (fields,
 * lists, engagement) as it is at that moment. It can also decide the email shouldn't go out.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PLACEHOLDER = /\{\{\s*[\w.-]+\s*\}\}/;
const MAX_DATA_CHARS = 6000;

export type OnError = 'retry' | 'send';
export const ON_ERROR: OnError[] = ['retry', 'send'];

export interface Draft {
  subject: string;
  body: string;
  html: boolean;
}

export type PersonalizeResult =
  | { ok: true; subject: string; body: string; skip?: undefined; cost: number | null; model: string }
  | { ok: true; skip: string; subject?: undefined; body?: undefined; cost: number | null; model: string }
  | { ok: false; error: string; cost: number | null; model: string };

/** The default system prompt; a template can replace it (templates.ai_system). */
export const DEFAULT_SYSTEM = [
  'You personalize one outbound email just before it is sent.',
  'You get instructions from the sender, data about the recipient (JSON), and the email as written from a template.',
  'Rewrite the email for this recipient following the instructions. Unless the instructions say otherwise:',
  '- keep the meaning, tone, length, structure, links and sign-off;',
  '- if the body is HTML, return HTML with the same structure and tags;',
  '- replace every {{placeholder}} left in the email with a value worked out from the data (e.g. a first name from the email address), or reword so it is not needed;',
  "- never invent facts that aren't in the data; when something is unknown, keep the original wording;",
  "- write naturally, as the sender; don't mention that the email was personalized or that you are an AI.",
].join('\n');

/** Always added after the system prompt (default or the template's own), so answers can be read. */
export function systemSuffix(today: string) {
  return [
    'If the instructions say not to send in a case that applies to this recipient, answer {"skip": true, "reason": "<short reason>"} instead.',
    'Answer with JSON only: {"subject": "...", "body": "..."}',
    `Today is ${today}.`,
  ].join('\n');
}

export function systemPrompt(today: string, custom?: string | null) {
  return `${(custom || '').trim() || DEFAULT_SYSTEM}\n${systemSuffix(today)}`;
}

export function userPrompt(instructions: string, data: unknown, draft: Draft) {
  let json = JSON.stringify(data, null, 1);
  if (json.length > MAX_DATA_CHARS) json = json.slice(0, MAX_DATA_CHARS) + '\n…(truncated)';
  return `Instructions:\n${instructions.trim() || '(none: just fill any {{placeholders}} sensibly)'}\n\nRecipient data:\n${json}\n\nEmail subject:\n${draft.subject}\n\nEmail body (${draft.html ? 'HTML' : 'plain text'}):\n${draft.body}`;
}

/** The first JSON object in the model's answer. */
export function parseAnswer(raw: string, draft: Draft): { subject: string; body: string } | { skip: string } | { error: string } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: `Model didn't answer with JSON: "${raw.slice(0, 80)}"` };
  let j: { subject?: unknown; body?: unknown; skip?: unknown; reason?: unknown };
  try {
    j = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { error: `Model's JSON didn't parse: "${raw.slice(start, start + 80)}"` };
  }
  if (j.skip === true || j.skip === 'true') return { skip: String(j.reason || 'the model decided not to send').slice(0, 200) };
  const subject = typeof j.subject === 'string' ? j.subject.trim() : '';
  const body = typeof j.body === 'string' ? j.body.trim() : '';
  if (!subject || !body) return { error: 'Model left the subject or body empty' };
  if (subject.length > 300) return { error: 'Model wrote a subject over 300 characters' };
  if (body.length > draft.body.length * 4 + 4000) return { error: 'Model wrote a much longer email than the template' };
  if (PLACEHOLDER.test(subject) || PLACEHOLDER.test(body)) return { error: 'Model left a {{placeholder}} in the email' };
  return { subject, body };
}

export async function personalize(env: Env, ai: { prompt: string; model?: string | null; system?: string | null }, draft: Draft, data: unknown): Promise<PersonalizeResult> {
  const model = ai.model || (await aiConfig(env)).model;
  if (!env.OPENROUTER_API_KEY) return { ok: false, error: 'OPENROUTER_API_KEY is not set (Settings)', cost: null, model };
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'x-title': 'Outbound personalization' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt(new Date(now()).toISOString().slice(0, 10), ai.system) },
          { role: 'user', content: userPrompt(ai.prompt, data, draft) },
        ],
        temperature: 0.4,
        max_tokens: Math.min(8000, 1200 + Math.ceil(draft.body.length / 2)),
        response_format: { type: 'json_object' },
        reasoning: { effort: 'low', exclude: true },
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const json = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number }; error?: { message?: string } };
    const cost = typeof json.usage?.cost === 'number' ? json.usage.cost : null;
    if (!res.ok || json.error) return { ok: false, error: `OpenRouter ${res.status}: ${json.error?.message || 'request failed'}`.slice(0, 300), cost, model };
    const a = parseAnswer(json.choices?.[0]?.message?.content || '', draft);
    if ('error' in a) return { ok: false, error: a.error, cost, model };
    if ('skip' in a) return { ok: true, skip: a.skip, cost, model };
    return { ok: true, subject: a.subject, body: a.body, cost, model };
  } catch (err) {
    return { ok: false, error: `OpenRouter request failed: ${(err as Error).message}`.slice(0, 300), cost: null, model };
  }
}

/** What the model gets to know about a recipient: contact fields and lists, how they've engaged, and the email's own data. */
export async function recipientData(env: Env, email: string, extra: Record<string, unknown> = {}) {
  const to = normEmail(email);
  const [c, eng] = await Promise.all([
    env.DB.prepare(
      `SELECT c.*, (SELECT group_concat(l.name, char(31)) FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = c.id) AS list_names
       FROM contacts c WHERE c.email = ?`,
    )
      .bind(to)
      .first<ContactRow & { list_names: string | null }>(),
    env.DB.prepare(
      `SELECT SUM(status IN ('sent','bounced')) AS sent, MAX(sent_at) AS last_sent, SUM(open_count > 0) AS opened, SUM(reply_count > 0) AS replied, MAX(last_reply_at) AS last_reply
       FROM emails WHERE to_email = ?`,
    )
      .bind(to)
      .first<{ sent: number | null; last_sent: number | null; opened: number | null; replied: number | null; last_reply: number | null }>(),
  ]);
  const day = (t: number | null | undefined) => (t ? new Date(t).toISOString().slice(0, 10) : null);
  const { to: _t, to_name: _n, ...fields } = c ? contactVars(c) : {};
  return {
    email: to,
    ...(c ? { name: c.name, fields, lists: c.list_names ? c.list_names.split('\u001f') : [], contact_since: day(c.created_at) } : { contact: 'not saved as a contact' }),
    engagement: { emails_sent: eng?.sent || 0, last_emailed: day(eng?.last_sent), opened_any: !!eng?.opened, replied_any: !!eng?.replied, last_replied: day(eng?.last_reply) },
    ...(Object.keys(extra).length ? { this_email: extra } : {}),
  };
}

export const leftoverPlaceholders = (s: string) => s.replace(/\{\{\s*[\w.-]+\s*\}\}/g, '');

export type SendDecision =
  | { action: 'send'; email: EmailRow }
  | { action: 'skip'; reason: string }
  | { action: 'retry' | 'fail'; reason: string };

/**
 * Called by the sender after it claims an email. Personalizes it once (a retry after a send error
 * reuses the result), records what happened, and says whether to send it.
 */
export async function prepareForSend(env: Env, e: EmailRow, lastAttempt: boolean): Promise<SendDecision> {
  if (!e.template_id || e.personalized_at) return { action: 'send', email: e };
  const t = await env.DB.prepare('SELECT * FROM templates WHERE template_id = ?').bind(e.template_id).first<TemplateRow>();
  const strip = (x: EmailRow): EmailRow => ({ ...x, subject: leftoverPlaceholders(x.subject), body_html: x.body_html && leftoverPlaceholders(x.body_html), body_text: x.body_text && leftoverPlaceholders(x.body_text) });
  if (!t || !t.ai_enabled) return { action: 'send', email: strip(e) };

  const html = !!e.body_html;
  const draft: Draft = { subject: e.subject, body: (html ? e.body_html : e.body_text) || '', html };
  let meta: Record<string, unknown> = {};
  try {
    meta = e.metadata ? JSON.parse(e.metadata) : {};
  } catch {
    /* not JSON */
  }
  const extra = { campaign: e.campaign, ...(typeof meta === 'object' && meta ? meta : {}) };
  const r = await personalize(env, { prompt: t.ai_prompt || '', model: t.ai_model, system: t.ai_system }, draft, await recipientData(env, e.to_email, extra));
  const t0 = now();
  if (r.ok && r.skip) {
    await env.DB.prepare("UPDATE emails SET status = 'skipped', status_reason = ?, ai_status = 'skipped', ai_note = ?, ai_model = ?, ai_cost = ?, personalized_at = ? WHERE id = ?")
      .bind(`AI: ${r.skip}`.slice(0, 300), r.skip, r.model, r.cost, t0, e.id)
      .run();
    return { action: 'skip', reason: r.skip };
  }
  if (r.ok) {
    // An HTML email's text part is derived from the HTML when it's built, so only one body is kept.
    const out = { ...e, subject: r.subject!, body_html: html ? r.body! : null, body_text: html ? null : r.body! };
    await env.DB.prepare("UPDATE emails SET subject = ?, body_html = ?, body_text = ?, ai_status = 'personalized', ai_note = NULL, ai_model = ?, ai_cost = ?, personalized_at = ? WHERE id = ?")
      .bind(out.subject, out.body_html, out.body_text, r.model, r.cost, t0, e.id)
      .run();
    return { action: 'send', email: out };
  }
  if (t.ai_on_error === 'send') {
    const out = strip(e);
    await env.DB.prepare("UPDATE emails SET subject = ?, body_html = ?, body_text = ?, ai_status = 'fallback', ai_note = ?, ai_model = ?, ai_cost = ?, personalized_at = ? WHERE id = ?")
      .bind(out.subject, out.body_html, out.body_text, r.error.slice(0, 300), r.model, r.cost, t0, e.id)
      .run();
    return { action: 'send', email: out };
  }
  await env.DB.prepare("UPDATE emails SET ai_status = 'failed', ai_note = ?, ai_model = ? WHERE id = ?").bind(r.error.slice(0, 300), r.model, e.id).run();
  return lastAttempt ? { action: 'fail', reason: `AI personalization failed: ${r.error}` } : { action: 'retry', reason: `AI personalization failed: ${r.error}` };
}

/**
 * Try a template's personalization on one recipient without sending anything. Unsaved instructions,
 * model, subject or body can be passed to test edits before saving.
 */
export async function previewPersonalization(
  env: Env,
  templateId: string | null,
  d: { contact?: string | number; email?: string; vars?: Record<string, unknown>; ai_prompt?: string; ai_model?: string; ai_system?: string | null; subject?: string; body?: string },
) {
  const t = templateId ? await getTemplateRow(env, normTemplateId(templateId)) : null;
  const subject = d.subject ?? t?.subject;
  const body = d.body ?? t?.body;
  if (!subject || !body) throw new HttpError(400, 'Give a template, or a subject and body');
  let email = d.email ? normEmail(d.email) : '';
  if (d.contact !== undefined && d.contact !== '') {
    const c = /^\d+$/.test(String(d.contact))
      ? await env.DB.prepare('SELECT email FROM contacts WHERE id = ?').bind(Number(d.contact)).first<{ email: string }>()
      : await env.DB.prepare('SELECT email FROM contacts WHERE email = ?').bind(normEmail(String(d.contact))).first<{ email: string }>();
    if (!c) throw new HttpError(404, `Contact not found: ${d.contact}`);
    email = c.email;
  }
  if (!email) throw new HttpError(400, 'Give a contact (email or id) to test with');
  const data = await recipientData(env, email, d.vars || {});
  // The template as it would be scheduled: known values filled in, missing ones left as {{placeholders}}.
  const vars: Record<string, string> = { email, to: email, ...Object.fromEntries(Object.entries((data as { fields?: Record<string, string> }).fields || {})) };
  if ((data as { name?: string }).name) Object.assign(vars, { name: (data as { name: string }).name, to_name: (data as { name: string }).name });
  for (const [k, v] of Object.entries(d.vars || {})) vars[k.toLowerCase()] = String(v ?? '');
  const html = isHtml(body);
  const fillKeep = (s: string, esc: boolean) =>
    s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => {
      const v = vars[k.toLowerCase()];
      return v ? (esc ? v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : v) : m;
    });
  const draft: Draft = { subject: fillKeep(subject, false), body: fillKeep(body, html), html };
  const r = await personalize(env, { prompt: d.ai_prompt ?? t?.ai_prompt ?? '', model: d.ai_model || t?.ai_model, system: d.ai_system !== undefined ? d.ai_system : t?.ai_system }, draft, data);
  return { to: email, draft, data, result: r };
}
