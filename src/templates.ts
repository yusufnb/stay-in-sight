import { escapeHtml, Env, HttpError, now } from './util';

/** {{ variable }} placeholders; names are case-insensitive. */
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Statuses that count as "this address has (or will) receive the template". */
export const TEMPLATE_TAKEN_STATUSES = ['scheduled', 'sending', 'sent', 'bounced'] as const;

export interface TemplateRow {
  id: number;
  template_id: string;
  name: string | null;
  subject: string;
  body: string;
  columns: string;
  ai_enabled: number;
  ai_prompt: string | null;
  ai_model: string | null;
  ai_on_error: string;
  ai_system: string | null;
  created_at: number;
  updated_at: number;
}

export const isHtml = (s: string) => /<[a-z][\s\S]*>/i.test(s);

/** CSV columns needed to fill every variable. Always starts with "to". */
export function templateColumns(subject: string, body: string): string[] {
  const out = new Set<string>(['to']);
  for (const src of [subject, body]) for (const m of src.matchAll(VAR_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

export function normTemplateId(v: unknown): string {
  const id = String(v ?? '').trim().toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, 'template_id must be 1-64 characters: letters, numbers, ".", "_" or "-", starting with a letter or number');
  return id;
}

/** Lowercase the keys so CSV headers match {{Variables}} regardless of case. */
export function normVars(vars: Record<string, unknown> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars || {})) out[k.trim().toLowerCase().replace(/\s+/g, '_')] = v == null ? '' : String(v).trim();
  return out;
}

/** Fill {{variables}}. keepMissing leaves unknown ones in place (for AI personalization to fill at send time). */
export function fill(tpl: string, vars: Record<string, string>, html: boolean, keepMissing = false): string {
  return tpl.replace(VAR_RE, (m, k: string) => {
    const v = vars[k.toLowerCase()] ?? '';
    if (!v && keepMissing) return m;
    return html ? escapeHtml(v) : v;
  });
}

/** Columns the template needs that are blank for this recipient. */
export function missingValues(t: TemplateRow, vars: Record<string, string>): string[] {
  // With AI personalization, the model fills in what's missing (e.g. a first name from the address).
  if (t.ai_enabled) return [];
  return (JSON.parse(t.columns) as string[]).filter((c) => !vars[c]);
}

export function renderTemplate(t: TemplateRow, vars: Record<string, string>) {
  const html = isHtml(t.body);
  const keep = !!t.ai_enabled;
  const body = fill(t.body, vars, html, keep);
  return { subject: fill(t.subject, vars, false, keep), body_html: html ? body : undefined, body_text: html ? undefined : body };
}

const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);

export function publicTemplate(t: TemplateRow, stats?: Record<string, number>) {
  return {
    template_id: t.template_id,
    name: t.name,
    subject: t.subject,
    body: t.body,
    columns: JSON.parse(t.columns) as string[],
    ai: { enabled: !!t.ai_enabled, prompt: t.ai_prompt, model: t.ai_model, on_error: t.ai_on_error || 'retry', system: t.ai_system ?? null },
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
    ...(stats ? { stats } : {}),
  };
}

export async function getTemplateRow(env: Env, templateId: string): Promise<TemplateRow> {
  const t = await env.DB.prepare('SELECT * FROM templates WHERE template_id = ?').bind(normTemplateId(templateId)).first<TemplateRow>();
  if (!t) throw new HttpError(404, `Template not found: ${templateId}`);
  return t;
}

async function templateStats(env: Env, templateId?: string) {
  const rows = await env.DB.prepare(
    `SELECT template_id, SUM(status IN ('sent','bounced')) AS sent, SUM(status IN ('scheduled','sending')) AS scheduled,
       SUM(open_count > 0) AS opened, SUM(reply_count > 0) AS replied
     FROM emails WHERE template_id IS NOT NULL ${templateId ? 'AND template_id = ?' : ''} GROUP BY template_id`,
  )
    .bind(...(templateId ? [templateId] : []))
    .all<{ template_id: string; sent: number; scheduled: number; opened: number; replied: number }>();
  return new Map(
    rows.results.map((r) => [r.template_id, { sent: r.sent || 0, scheduled: r.scheduled || 0, opened: r.opened || 0, replied: r.replied || 0 }]),
  );
}

const zero = { sent: 0, scheduled: 0, opened: 0, replied: 0 };

export async function listTemplates(env: Env) {
  const [rows, stats] = await Promise.all([env.DB.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all<TemplateRow>(), templateStats(env)]);
  return rows.results.map((t) => publicTemplate(t, stats.get(t.template_id) || zero));
}

export async function getTemplate(env: Env, templateId: string) {
  const t = await getTemplateRow(env, templateId);
  return publicTemplate(t, (await templateStats(env, t.template_id)).get(t.template_id) || zero);
}

export interface TemplateAiInput {
  /** Rewrite each email with AI just before it is sent. */
  ai_enabled?: boolean;
  /** What to change, in plain words. */
  ai_prompt?: string | null;
  /** OpenRouter model id; empty = the app's AI model. */
  ai_model?: string | null;
  /** retry (a few times, then fail) or send (as written). */
  ai_on_error?: string;
  /** Replaces the default system prompt for this template; empty or null = the default. */
  ai_system?: string | null;
}

/** Clean AI settings into column values (only the ones given). */
function aiColumns(d: TemplateAiInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d.ai_enabled !== undefined) out.ai_enabled = d.ai_enabled ? 1 : 0;
  if (d.ai_prompt !== undefined) {
    const p = String(d.ai_prompt ?? '').trim();
    if (p.length > 4000) throw new HttpError(400, 'ai_prompt must be 4000 characters or fewer');
    out.ai_prompt = p || null;
  }
  if (d.ai_model !== undefined) {
    const m = String(d.ai_model ?? '').trim();
    if (m && !/^[\w.-]+\/[\w.:-]+$/.test(m)) throw new HttpError(400, 'ai_model must be an OpenRouter model id like "openai/gpt-6-luna"');
    out.ai_model = m || null;
  }
  if (d.ai_system !== undefined) {
    const sys = String(d.ai_system ?? '').trim();
    if (sys.length > 8000) throw new HttpError(400, 'ai_system must be 8000 characters or fewer');
    out.ai_system = sys || null;
  }
  if (d.ai_on_error !== undefined) {
    if (!['retry', 'send'].includes(String(d.ai_on_error))) throw new HttpError(400, 'ai_on_error must be retry or send');
    out.ai_on_error = String(d.ai_on_error);
  }
  return out;
}

function validateContent(subject: unknown, body: unknown) {
  if (!String(subject ?? '').trim()) throw new HttpError(400, 'subject is required');
  if (!String(body ?? '').trim()) throw new HttpError(400, 'body is required');
}

export async function createTemplate(env: Env, d: { template_id: string; name?: string; subject: string; body: string } & TemplateAiInput) {
  const id = normTemplateId(d.template_id);
  validateContent(d.subject, d.body);
  const ai = aiColumns(d);
  const exists = await env.DB.prepare('SELECT 1 FROM templates WHERE template_id = ?').bind(id).first();
  if (exists) throw new HttpError(409, `Template "${id}" already exists`);
  const cols = ['template_id', 'name', 'subject', 'body', 'columns', 'created_at', 'updated_at', ...Object.keys(ai)];
  await env.DB.prepare(`INSERT INTO templates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(id, d.name?.trim() || null, d.subject, d.body, JSON.stringify(templateColumns(d.subject, d.body)), now(), now(), ...Object.values(ai))
    .run();
  return getTemplate(env, id);
}

/** template_id can't change: it is what keeps a template from reaching the same address twice. */
export async function updateTemplate(env: Env, templateId: string, patch: { name?: string; subject?: string; body?: string } & TemplateAiInput) {
  const t = await getTemplateRow(env, templateId);
  const subject = patch.subject ?? t.subject;
  const body = patch.body ?? t.body;
  validateContent(subject, body);
  const ai = aiColumns(patch);
  await env.DB.prepare(`UPDATE templates SET name = ?, subject = ?, body = ?, columns = ?, updated_at = ?${Object.keys(ai).map((k) => `, ${k} = ?`).join('')} WHERE id = ?`)
    .bind(patch.name !== undefined ? (patch.name ?? '').trim() || null : t.name, subject, body, JSON.stringify(templateColumns(subject, body)), now(), ...Object.values(ai), t.id)
    .run();
  return getTemplate(env, t.template_id);
}

/** Deleting keeps email history, so re-creating the same template_id still skips everyone who got it. */
export async function deleteTemplate(env: Env, templateId: string) {
  const t = await getTemplateRow(env, templateId);
  await env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(t.id).run();
  return { deleted: t.template_id };
}

/** Which of these addresses already have this template queued or sent. */
export async function templateRecipients(env: Env, templateId: string, emails: string[]): Promise<Map<string, string>> {
  const id = normTemplateId(templateId);
  const list = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const out = new Map<string, string>();
  const st = TEMPLATE_TAKEN_STATUSES.map(() => '?').join(',');
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT to_email, status FROM emails WHERE template_id = ? AND status IN (${st}) AND to_email IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(id, ...TEMPLATE_TAKEN_STATUSES, ...chunk)
      .all<{ to_email: string; status: string }>();
    rows.results.forEach((r) => out.set(r.to_email, r.status));
  }
  return out;
}

export async function checkTemplateRecipients(env: Env, templateId: string, emails: string[]) {
  await getTemplateRow(env, templateId);
  const taken = await templateRecipients(env, templateId, emails);
  const uniq = new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean));
  return {
    template_id: normTemplateId(templateId),
    checked: uniq.size,
    already_received: [...taken].map(([to, status]) => ({ to, status })),
    new_recipients: uniq.size - taken.size,
  };
}
