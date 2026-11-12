import { Env, getSetting, HttpError, now, setSetting } from './util';

export const STOP = 'stop';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_CATEGORIES = 30;
const DEFAULT_MODEL = 'openai/gpt-6-luna';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface CategoryRow {
  id: number;
  name: string;
  description: string;
  is_system: number;
  sort: number;
  created_at: number;
}

// ---------- Categories ----------

export function normCategoryName(v: unknown): string {
  const n = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!NAME_RE.test(n)) throw new HttpError(400, 'Category name must be 1-40 characters: letters, numbers, "_" or "-"');
  return n;
}

export const publicCategory = (c: CategoryRow) => ({ name: c.name, description: c.description, system: !!c.is_system });

export async function categoryRows(env: Env): Promise<CategoryRow[]> {
  return (await env.DB.prepare('SELECT * FROM categories ORDER BY sort, id').all<CategoryRow>()).results;
}

export async function listCategories(env: Env) {
  const [rows, counts] = await Promise.all([
    categoryRows(env),
    env.DB.prepare('SELECT category, COUNT(*) AS n FROM replies WHERE category IS NOT NULL GROUP BY category').all<{ category: string; n: number }>(),
  ]);
  const m = new Map(counts.results.map((c) => [c.category, c.n]));
  return rows.map((c) => ({ ...publicCategory(c), replies: m.get(c.name) ?? 0 }));
}

/** Create, or update the description (and name, unless it's "stop") of an existing category. */
export async function saveCategory(env: Env, d: { name: string; description: string; rename_to?: string; create_only?: boolean }) {
  const name = normCategoryName(d.name);
  const description = String(d.description ?? '').trim();
  if (!description) throw new HttpError(400, 'description is required: it is what the model reads to pick the category');
  if (description.length > 500) throw new HttpError(400, 'description must be 500 characters or fewer');
  const existing = await env.DB.prepare('SELECT * FROM categories WHERE name = ?').bind(name).first<CategoryRow>();
  if (existing && d.create_only) throw new HttpError(409, `Category "${name}" already exists`);
  if (existing) {
    let newName = name;
    if (d.rename_to !== undefined && normCategoryName(d.rename_to) !== name) {
      if (existing.is_system) throw new HttpError(400, `"${name}" can't be renamed`);
      newName = normCategoryName(d.rename_to);
      if (await env.DB.prepare('SELECT 1 FROM categories WHERE name = ?').bind(newName).first()) throw new HttpError(409, `Category "${newName}" already exists`);
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE categories SET name = ?, description = ? WHERE id = ?').bind(newName, description, existing.id),
      env.DB.prepare('UPDATE replies SET category = ? WHERE category = ?').bind(newName, name),
    ]);
    return publicCategory({ ...existing, name: newName, description });
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM categories').first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_CATEGORIES) throw new HttpError(400, `At most ${MAX_CATEGORIES} categories`);
  const sort = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories').first<{ s: number }>();
  await env.DB.prepare('INSERT INTO categories (name, description, is_system, sort, created_at) VALUES (?, ?, 0, ?, ?)')
    .bind(name, description, sort?.s ?? 1, now())
    .run();
  return publicCategory({ id: 0, name, description, is_system: 0, sort: 0, created_at: now() });
}

/** Past replies keep their category label; it just won't be assigned anymore. */
export async function deleteCategory(env: Env, nameRaw: string) {
  const name = normCategoryName(nameRaw);
  const c = await env.DB.prepare('SELECT * FROM categories WHERE name = ?').bind(name).first<CategoryRow>();
  if (!c) throw new HttpError(404, `Category not found: ${name}`);
  if (c.is_system) throw new HttpError(400, `"${name}" is required and can't be deleted`);
  await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(c.id).run();
  return { deleted: name };
}

// ---------- AI settings ----------

const MAX_CONTEXT = 2000;

export async function aiConfig(env: Env) {
  const [model, context] = await Promise.all([getSetting(env, 'ai_model'), getSetting(env, 'ai_context')]);
  return {
    configured: !!env.OPENROUTER_API_KEY,
    model: model || env.OPENROUTER_MODEL || DEFAULT_MODEL,
    default_model: env.OPENROUTER_MODEL || DEFAULT_MODEL,
    context: context || '',
    system_prompt: systemPrompt(context || ''),
  };
}

/** Update the categorizer's model and/or the "about your outreach" context in its system prompt. */
export async function setAiSettings(env: Env, d: { model?: string; context?: string }) {
  if (d.model !== undefined) {
    const m = String(d.model ?? '').trim();
    if (!/^[\w.-]+\/[\w.:-]+$/.test(m)) throw new HttpError(400, 'model must be an OpenRouter model id like "openai/gpt-6-luna"');
    await setSetting(env, 'ai_model', m);
  }
  if (d.context !== undefined) {
    const c = String(d.context ?? '').trim();
    if (c.length > MAX_CONTEXT) throw new HttpError(400, `context must be ${MAX_CONTEXT} characters or fewer`);
    await setSetting(env, 'ai_context', c);
  }
  return aiConfig(env);
}

/** The system prompt: what this is, who "we" are (your context), and how to answer. */
export function systemPrompt(context: string): string {
  return [
    'You categorize replies to outbound emails. We sent someone an email (usually a first cold outreach or a follow-up), they wrote back, and you decide what kind of reply it is so the right next step happens: a sales follow-up, a handoff, or never emailing them again.',
    context.trim() ? `About us and our outreach:\n${context.trim()}` : '',
    [
      'How to decide:',
      '- Read their reply, using our original email for context. Judge what they want, not the words they happen to use.',
      `- If they ask in any way not to be emailed again (unsubscribe, remove me, stop, don't contact me, a firm "not interested, leave me alone"), answer "${STOP}". This always wins.`,
      '- Otherwise pick the single category whose description fits best. Use the most specific one.',
      '- Answer with exactly one category name from the list. No punctuation, quotes or explanation.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------- Categorizing ----------

export interface CategorizeInput {
  reply: string;
  reply_subject?: string;
  original_subject?: string;
  original_body?: string;
}

export interface CategorizeResult {
  category: string | null;
  source: 'ai' | 'rule' | null;
  cost: number | null;
  error: string | null;
  model?: string;
  raw?: string;
}

const clip = (s: string | undefined, n: number) => {
  const t = (s || '').replace(/\s+\n/g, '\n').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export function buildPrompt(cats: { name: string; description: string }[], input: CategorizeInput, context = '') {
  const system = systemPrompt(context);
  const user = [
    'Categories:',
    ...cats.map((c) => `- ${c.name}: ${c.description}`),
    '',
    input.original_subject ? `Our email subject: ${clip(input.original_subject, 200)}` : '',
    input.original_body ? `Our email (start):\n${clip(input.original_body, 600)}` : '',
    '',
    `Their reply${input.reply_subject ? ` (subject: ${clip(input.reply_subject, 200)})` : ''}:`,
    '"""',
    clip(input.reply, 2000) || '(empty)',
    '"""',
    '',
    'Category name:',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  return { system, user };
}

/** Map the model's answer onto a known category name. */
export function matchCategory(raw: string, names: string[]): string | null {
  const t = raw.trim().toLowerCase().replace(/^["'`*\s]+|["'`*.\s]+$/g, '');
  if (names.includes(t)) return t;
  const norm = t.replace(/\s+/g, '_');
  if (names.includes(norm)) return norm;
  // Longest name mentioned anywhere, e.g. "Category: new_site"
  const hits = names.filter((n) => new RegExp(`(^|[^a-z0-9_-])${n.replace(/[-]/g, '\\-')}($|[^a-z0-9_-])`).test(t)).sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}

/** Ask OpenRouter which category a reply belongs to. Never throws: failures come back in `error`. */
export async function categorize(env: Env, input: CategorizeInput): Promise<CategorizeResult> {
  if (!env.OPENROUTER_API_KEY) return { category: null, source: null, cost: null, error: 'OPENROUTER_API_KEY is not set' };
  const [cats, cfg] = await Promise.all([categoryRows(env), aiConfig(env)]);
  if (!cats.length) return { category: null, source: null, cost: null, error: 'No categories defined' };
  const { system, user } = buildPrompt(cats, input, cfg.context);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'x-title': 'Outbound reply categorizer',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 400, // the answer is one word; headroom for models that reason first
        reasoning: { effort: 'low', exclude: true },
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      usage?: { cost?: number };
      error?: { message?: string };
    };
    if (!res.ok || json.error) return { category: null, source: null, cost: null, model: cfg.model, error: `OpenRouter ${res.status}: ${json.error?.message || 'request failed'}`.slice(0, 300) };
    const raw = json.choices?.[0]?.message?.content || '';
    const category = matchCategory(raw, cats.map((c) => c.name));
    return {
      category,
      source: category ? 'ai' : null,
      cost: typeof json.usage?.cost === 'number' ? json.usage.cost : null,
      model: cfg.model,
      raw: raw.slice(0, 200),
      error: category ? null : `Model answered "${raw.slice(0, 80)}", which is not a category`,
    };
  } catch (err) {
    return { category: null, source: null, cost: null, model: cfg.model, error: `OpenRouter request failed: ${(err as Error).message}`.slice(0, 300) };
  }
}
