import { dncLookup, getGroupRow, getMailbox, scheduleEmails, ScheduleInput } from './service';
import { getSenderRow } from './senders';
import { Purpose, purposeOf } from './purpose';
import { getTemplateRow, missingValues, normVars, renderTemplate, templateColumns, templateRecipients, TemplateRow } from './templates';
import { Env, HttpError, isEmail, normEmail, now, parseTime } from './util';

const MAX_IMPORT = 5000;
const MAX_LIST_SEND = 5000;
const SEND_CHUNK = 1000;

export interface ContactRow {
  id: number;
  email: string;
  name: string | null;
  fields: string;
  created_at: number;
  updated_at: number;
}
export interface ListRow {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
}

const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
const qs = (n: number) => Array.from({ length: n }, () => '?').join(',');
const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Columns that hold the address and name; everything else becomes a field. */
const EMAIL_KEYS = ['email', 'to', 'email_address', 'e-mail'];
const NAME_KEYS = ['name', 'to_name', 'full_name'];

const parseFields = (c: ContactRow): Record<string, string> => {
  try {
    return JSON.parse(c.fields || '{}');
  } catch {
    return {};
  }
};

/** Values a template or message can use for this contact: every field, plus email/to and name/to_name. */
export function contactVars(c: ContactRow): Record<string, string> {
  const f = parseFields(c);
  const v: Record<string, string> = { ...f, email: c.email, to: c.email };
  if (c.name) Object.assign(v, { name: c.name, to_name: c.name });
  return v;
}

export function publicContact(c: ContactRow & { list_names?: string | null; sent_count?: number; dnc?: string | null; last_sent_at?: number | null }) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    fields: parseFields(c),
    lists: c.list_names ? c.list_names.split('\u001f').sort() : [],
    sent_count: c.sent_count ?? 0,
    last_sent_at: iso(c.last_sent_at),
    do_not_send: !!c.dnc,
    do_not_send_scope: c.dnc || null,
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
  };
}

// ---------- Lists ----------

export function normListName(v: unknown): string {
  const n = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!n || n.length > 60) throw new HttpError(400, 'List names must be 1-60 characters');
  return n;
}

export async function listLists(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT l.*, (SELECT COUNT(*) FROM list_contacts lc WHERE lc.list_id = l.id) AS contacts FROM lists l ORDER BY l.name COLLATE NOCASE`,
  ).all<ListRow & { contacts: number }>();
  return rows.results.map((l) => ({ id: l.id, name: l.name, description: l.description, contacts: l.contacts, created_at: iso(l.created_at) }));
}

/** Look up lists by id or name. With create, missing names are created. */
export async function resolveLists(env: Env, refs: (string | number)[], create = false): Promise<ListRow[]> {
  const out = new Map<number, ListRow>();
  for (const ref of refs) {
    const byId = typeof ref === 'number' || /^\d+$/.test(String(ref));
    let l = byId
      ? await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(Number(ref)).first<ListRow>()
      : await env.DB.prepare('SELECT * FROM lists WHERE name = ?').bind(normListName(ref)).first<ListRow>();
    if (!l && !byId && create) {
      await env.DB.prepare('INSERT OR IGNORE INTO lists (name, created_at) VALUES (?, ?)').bind(normListName(ref), now()).run();
      l = await env.DB.prepare('SELECT * FROM lists WHERE name = ?').bind(normListName(ref)).first<ListRow>();
    }
    if (!l) throw new HttpError(404, `List not found: ${ref}`);
    out.set(l.id, l);
  }
  return [...out.values()];
}

export async function createList(env: Env, d: { name: string; description?: string }) {
  const name = normListName(d.name);
  if (await env.DB.prepare('SELECT 1 FROM lists WHERE name = ?').bind(name).first()) throw new HttpError(409, `List "${name}" already exists`);
  await env.DB.prepare('INSERT INTO lists (name, description, created_at) VALUES (?, ?, ?)').bind(name, d.description?.trim() || null, now()).run();
  return (await listLists(env)).find((l) => l.name.toLowerCase() === name.toLowerCase());
}

export async function updateList(env: Env, ref: string | number, d: { name?: string; description?: string }) {
  const [l] = await resolveLists(env, [ref]);
  const name = d.name !== undefined ? normListName(d.name) : l.name;
  if (name.toLowerCase() !== l.name.toLowerCase() && (await env.DB.prepare('SELECT 1 FROM lists WHERE name = ?').bind(name).first())) {
    throw new HttpError(409, `List "${name}" already exists`);
  }
  await env.DB.prepare('UPDATE lists SET name = ?, description = ? WHERE id = ?')
    .bind(name, d.description !== undefined ? d.description.trim() || null : l.description, l.id)
    .run();
  return (await listLists(env)).find((x) => x.id === l.id);
}

/** Deletes the list only; its contacts stay. */
export async function deleteList(env: Env, ref: string | number) {
  const [l] = await resolveLists(env, [ref]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM list_contacts WHERE list_id = ?').bind(l.id),
    env.DB.prepare('DELETE FROM series_lists WHERE list_id = ?').bind(l.id),
    env.DB.prepare('DELETE FROM lists WHERE id = ?').bind(l.id),
  ]);
  return { deleted: l.name };
}

// ---------- Contacts ----------

const normKey = (k: string) => k.trim().toLowerCase().replace(/\s+/g, '_');

/** Turn uploaded rows into contacts: an email column is required, a name column is optional, the rest are fields. */
export function parseContactRows(rows: Record<string, unknown>[]) {
  // name is only set when a name column was given; otherwise it's derived from first/last name after merging.
  const contacts = new Map<string, { email: string; name: string | null; fields: Record<string, string> }>();
  const invalid: { row: number; reason: string; value?: string }[] = [];
  rows.forEach((raw, i) => {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw || {})) r[normKey(k)] = v == null ? '' : String(v).trim();
    const emailKey = EMAIL_KEYS.find((k) => r[k]);
    const email = normEmail(emailKey ? r[emailKey] : '');
    if (!email) return void invalid.push({ row: i + 1, reason: 'no email' });
    if (!isEmail(email)) return void invalid.push({ row: i + 1, reason: 'invalid email', value: email });
    const nameKey = NAME_KEYS.find((k) => r[k]);
    const name = nameKey ? r[nameKey] : '';
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) if (v && !EMAIL_KEYS.includes(k) && !NAME_KEYS.includes(k)) fields[k] = v.slice(0, 2000);
    const prev = contacts.get(email); // same address twice in one upload: later values win
    contacts.set(email, { email, name: name || prev?.name || null, fields: { ...prev?.fields, ...fields } });
  });
  return { contacts: [...contacts.values()], invalid };
}

async function contactsByEmail(env: Env, emails: string[]) {
  const out = new Map<string, ContactRow>();
  for (const c of chunks(emails, 90)) {
    const r = await env.DB.prepare(`SELECT * FROM contacts WHERE email IN (${qs(c.length)})`).bind(...c).all<ContactRow>();
    r.results.forEach((x) => out.set(x.email, x));
  }
  return out;
}

/**
 * Add or update contacts by email and put them on lists. Existing contacts keep fields the upload
 * doesn't mention; blank cells never erase a value.
 */
export async function importContacts(env: Env, d: { rows: Record<string, unknown>[]; lists?: (string | number)[] }) {
  if (!Array.isArray(d.rows) || !d.rows.length) throw new HttpError(400, 'No rows to import');
  if (d.rows.length > MAX_IMPORT) throw new HttpError(400, `At most ${MAX_IMPORT} rows per import`);
  const { contacts, invalid } = parseContactRows(d.rows);
  const lists = d.lists?.length ? await resolveLists(env, d.lists, true) : [];
  const existing = await contactsByEmail(env, contacts.map((c) => c.email));
  const t = now();
  const stmts = contacts.map((c) => {
    const old = existing.get(c.email);
    const fields = { ...(old ? parseFields(old) : {}), ...c.fields };
    // No explicit name: build it from first/last name (after merging), so updating one part keeps the other.
    const derived = [fields.first_name, fields.last_name].filter(Boolean).join(' ');
    const name = c.name || (('first_name' in c.fields || 'last_name' in c.fields) && derived ? derived : null);
    return env.DB.prepare(
      `INSERT INTO contacts (email, name, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, contacts.name), fields = excluded.fields, updated_at = excluded.updated_at`,
    ).bind(c.email, name, JSON.stringify(fields), t, t);
  });
  for (const c of chunks(stmts, 200)) await env.DB.batch(c);

  const added: { list: string; added: number }[] = [];
  if (lists.length && contacts.length) {
    const ids = [...(await contactsByEmail(env, contacts.map((c) => c.email))).values()].map((c) => c.id);
    for (const l of lists) {
      let n = 0;
      for (const c of chunks(ids, 200)) {
        const res = await env.DB.batch(c.map((id) => env.DB.prepare('INSERT OR IGNORE INTO list_contacts (list_id, contact_id, added_at) VALUES (?, ?, ?)').bind(l.id, id, t)));
        n += res.reduce((s, r) => s + r.meta.changes, 0);
      }
      added.push({ list: l.name, added: n });
    }
  }
  const dnc = await dncLookup(env, contacts.map((c) => c.email));
  return {
    rows: d.rows.length,
    created: contacts.filter((c) => !existing.has(c.email)).length,
    updated: contacts.filter((c) => existing.has(c.email)).length,
    invalid,
    lists: added,
    on_do_not_send: dnc.size,
  };
}

/**
 * Add one contact, or update it if the email already exists. Any attribute can be given at the top level
 * (first_name, last_name, company, phone, …) and/or inside `fields`; `lists` puts them on lists.
 * Same rules as import: values update, blanks never erase.
 */
export async function saveContact(env: Env, body: Record<string, unknown>) {
  const { lists, fields, ...rest } = body || {};
  if (fields !== undefined && (typeof fields !== 'object' || fields === null || Array.isArray(fields))) throw new HttpError(400, 'fields must be an object');
  const row: Record<string, unknown> = { ...(fields as Record<string, unknown>), ...rest };
  for (const [k, v] of Object.entries(row)) if (v !== null && typeof v === 'object') throw new HttpError(400, `${k} must be a text value`);
  const listRefs = lists === undefined ? [] : Array.isArray(lists) ? (lists as (string | number)[]) : [lists as string];
  const r = await importContacts(env, { rows: [row], lists: listRefs });
  if (r.invalid.length) throw new HttpError(400, r.invalid[0].reason === 'no email' ? 'email is required' : `Invalid email: ${r.invalid[0].value}`);
  const c = await env.DB.prepare('SELECT id FROM contacts WHERE email = ?').bind(normEmail(String(row.email ?? row.to ?? row.email_address ?? ''))).first<{ id: number }>();
  return { created: r.created === 1, contact: await getContact(env, c!.id) };
}

const CONTACT_SELECT = `SELECT c.*,
  (SELECT group_concat(l.name, char(31)) FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = c.id) AS list_names,
  (SELECT COUNT(*) FROM emails e WHERE e.to_email = c.email AND e.status IN ('sent','bounced')) AS sent_count,
  (SELECT MAX(sent_at) FROM emails e WHERE e.to_email = c.email) AS last_sent_at,
  (SELECT scope FROM dnc d WHERE d.email = c.email) AS dnc
  FROM contacts c`;

// ---------- Filtering, sorting and selecting contacts ----------

/**
 * One condition. field: email | name | field:<key> (any contact field) | sent_count | created_at | updated_at |
 * last_sent_at | last_reply_at | opened | replied | do_not_send | list | series.
 * op by kind of field —
 *   text:    is, is_not, contains, not_contains, starts_with, ends_with, is_empty, is_not_empty, gt, lt (numeric)
 *   number:  is, gt, lt
 *   date:    within_days, older_than_days (value = N), before, after (value = date), is_empty (never), is_not_empty
 *   yes/no:  is (value true/false)
 *   list, series: in, not_in (value = name or id)
 */
export interface ContactRule {
  field: string;
  op: string;
  value?: unknown;
}

export interface ContactFilter {
  list?: string | number;
  q?: string;
  email?: string;
  /** Rules (or their JSON, from a query string). */
  rules?: ContactRule[] | string;
  /** all (default): every rule must match; any: at least one. */
  match?: 'all' | 'any';
}

const DAY = 86_400_000;
const FIELD_KEY_RE = /^[a-z0-9_.-]{1,64}$/;
const SENT_COUNT = `(SELECT COUNT(*) FROM emails e WHERE e.to_email = c.email AND e.status IN ('sent','bounced'))`;
const LAST_SENT = '(SELECT MAX(sent_at) FROM emails e WHERE e.to_email = c.email)';
const LAST_REPLY = "(SELECT MAX(r.received_at) FROM replies r JOIN emails e ON e.id = r.email_id WHERE e.to_email = c.email AND r.kind IN ('reply','stop'))";
const FLAGS: Record<string, string> = {
  opened: 'EXISTS (SELECT 1 FROM emails e WHERE e.to_email = c.email AND e.open_count > 0)',
  replied: 'EXISTS (SELECT 1 FROM emails e WHERE e.to_email = c.email AND e.reply_count > 0)',
  do_not_send: 'EXISTS (SELECT 1 FROM dnc d WHERE d.email = c.email)',
};
const DATES: Record<string, string> = { created_at: 'c.created_at', updated_at: 'c.updated_at', last_sent_at: LAST_SENT, last_reply_at: LAST_REPLY };
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function fieldExpr(field: string): { expr: string; vals: unknown[] } | null {
  if (field === 'email') return { expr: 'c.email', vals: [] };
  if (field === 'name') return { expr: "COALESCE(c.name, '')", vals: [] };
  if (field.startsWith('field:')) {
    const key = field.slice(6).trim().toLowerCase();
    if (!FIELD_KEY_RE.test(key)) throw new HttpError(400, `Unknown field: ${field}`);
    return { expr: "COALESCE(CAST(json_extract(c.fields, ?) AS TEXT), '')", vals: [`$."${key}"`] };
  }
  return null;
}

function parseDay(v: unknown, field: string) {
  const t = Date.parse(String(v ?? ''));
  if (Number.isNaN(t)) throw new HttpError(400, `Filter on ${field}: "${v}" isn't a date`);
  return t;
}

async function ruleSql(env: Env, r: ContactRule): Promise<{ sql: string; vals: unknown[] }> {
  const field = String(r?.field ?? '').trim();
  const op = String(r?.op ?? '').trim();
  const v = r?.value;
  const bad = (m: string) => new HttpError(400, `Filter on ${field || '?'}: ${m}`);
  const text = fieldExpr(field);
  if (text) {
    const { expr: E, vals: ev } = text;
    const s = String(v ?? '').trim();
    switch (op) {
      case 'is': return { sql: `LOWER(${E}) = LOWER(?)`, vals: [...ev, s] };
      case 'is_not': return { sql: `LOWER(${E}) <> LOWER(?)`, vals: [...ev, s] };
      case 'contains': return { sql: `${E} LIKE ? ESCAPE '\\'`, vals: [...ev, `%${likeEsc(s)}%`] };
      case 'not_contains': return { sql: `${E} NOT LIKE ? ESCAPE '\\'`, vals: [...ev, `%${likeEsc(s)}%`] };
      case 'starts_with': return { sql: `${E} LIKE ? ESCAPE '\\'`, vals: [...ev, `${likeEsc(s)}%`] };
      case 'ends_with': return { sql: `${E} LIKE ? ESCAPE '\\'`, vals: [...ev, `%${likeEsc(s)}`] };
      case 'is_empty': return { sql: `${E} = ''`, vals: ev };
      case 'is_not_empty': return { sql: `${E} <> ''`, vals: ev };
      case 'gt':
      case 'lt': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw bad(`"${v}" isn't a number`);
        return { sql: `(${E} <> '' AND CAST(${E} AS REAL) ${op === 'gt' ? '>' : '<'} ?)`, vals: [...ev, ...ev, n] };
      }
    }
    throw bad(`unknown operator "${op}"`);
  }
  if (field === 'sent_count') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw bad('value must be a whole number');
    const cmp = { is: '=', gt: '>', lt: '<' }[op];
    if (!cmp) throw bad(`unknown operator "${op}"`);
    return { sql: `${SENT_COUNT} ${cmp} ?`, vals: [n] };
  }
  if (DATES[field]) {
    const E = DATES[field];
    switch (op) {
      case 'within_days':
      case 'older_than_days': {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw bad('value must be a number of days');
        return { sql: `${E} ${op === 'within_days' ? '>=' : '<'} ?`, vals: [now() - n * DAY] };
      }
      case 'before': return { sql: `${E} < ?`, vals: [parseDay(v, field)] };
      case 'after': return { sql: `${E} >= ?`, vals: [parseDay(v, field) + (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? DAY : 0)] };
      case 'is_empty': return { sql: `${E} IS NULL`, vals: [] };
      case 'is_not_empty': return { sql: `${E} IS NOT NULL`, vals: [] };
    }
    throw bad(`unknown operator "${op}"`);
  }
  if (FLAGS[field]) {
    if (op !== 'is') throw bad('use op "is" with true or false');
    const yes = v === true || v === 'true' || v === 1 || v === '1' || v === 'yes';
    return { sql: yes ? FLAGS[field] : `NOT ${FLAGS[field]}`, vals: [] };
  }
  if (field === 'list' || field === 'series') {
    if (op !== 'in' && op !== 'not_in') throw bad('use op "in" or "not_in"');
    let id: number;
    if (field === 'list') id = (await resolveLists(env, [v as string]))[0].id;
    else {
      const byId = /^\d+$/.test(String(v));
      const sr = await env.DB.prepare(`SELECT id FROM series WHERE ${byId ? 'id' : 'name'} = ?`).bind(byId ? Number(v) : String(v ?? '')).first<{ id: number }>();
      if (!sr) throw new HttpError(404, `Series not found: ${v}`);
      id = sr.id;
    }
    const sub = field === 'list' ? 'SELECT contact_id FROM list_contacts WHERE list_id = ?' : 'SELECT contact_id FROM series_enrollments WHERE series_id = ?';
    return { sql: `c.id ${op === 'in' ? 'IN' : 'NOT IN'} (${sub})`, vals: [id] };
  }
  throw bad('unknown field');
}

/** WHERE clause (with "c" as the contacts alias) for a filter. */
export async function contactWhere(env: Env, f: ContactFilter = {}) {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (f.email) (where.push('c.email = ?'), vals.push(normEmail(f.email)));
  if (f.list !== undefined && f.list !== '' && f.list !== null) {
    const [l] = await resolveLists(env, [f.list]);
    where.push('c.id IN (SELECT contact_id FROM list_contacts WHERE list_id = ?)');
    vals.push(l.id);
  }
  if (f.q) {
    const like = `%${likeEsc(String(f.q).trim())}%`;
    where.push(`(c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.fields LIKE ? ESCAPE '\\')`);
    vals.push(like, like, like);
  }
  let rules = f.rules;
  if (typeof rules === 'string' && rules.trim()) {
    try {
      rules = JSON.parse(rules) as ContactRule[];
    } catch {
      throw new HttpError(400, 'rules must be a JSON list of {field, op, value}');
    }
  }
  if (Array.isArray(rules) && rules.length) {
    if (rules.length > 20) throw new HttpError(400, 'At most 20 filter rules');
    const parts = await Promise.all(rules.map((r) => ruleSql(env, r)));
    where.push(`(${parts.map((p) => `(${p.sql})`).join(f.match === 'any' ? ' OR ' : ' AND ')})`);
    parts.forEach((p) => vals.push(...p.vals));
  }
  return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', vals };
}

const SORTS: Record<string, string> = {
  name: "COALESCE(NULLIF(c.name, ''), c.email) COLLATE NOCASE",
  email: 'c.email',
  lists: 'list_names COLLATE NOCASE',
  sent_count: 'sent_count',
  last_sent_at: 'last_sent_at',
  created_at: 'c.created_at',
  updated_at: 'c.updated_at',
};

/** ORDER BY for a sort key (any column above, or field:<key>); empty values always last. */
function orderBy(sort: unknown, dir: unknown): { sql: string; vals: unknown[] } {
  const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const key = String(sort || 'updated_at');
  const expr = SORTS[key];
  const vals: unknown[] = [];
  if (!expr && key.startsWith('field:')) {
    // Fields are text: numbers sort by value (9 before 10), then text alphabetically; empty last.
    const f = fieldExpr(key)!;
    const e = `NULLIF(${f.expr}, '')`;
    return { sql: `ORDER BY ${e} IS NULL, CAST(${e} AS REAL) ${d}, ${e} COLLATE NOCASE ${d}, c.id ${d}`, vals: [...f.vals, ...f.vals, ...f.vals] };
  }
  if (!expr) throw new HttpError(400, `Can't sort by ${key}. Use one of: ${Object.keys(SORTS).join(', ')}, or field:<name>`);
  return { sql: `ORDER BY (${expr}) IS NULL, ${expr} ${d}, c.id ${d}`, vals };
}

export async function listContacts(env: Env, f: ContactFilter & { sort?: string; dir?: string; limit?: number; offset?: number }) {
  const { w, vals } = await contactWhere(env, f);
  const order = orderBy(f.sort, f.dir);
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const [rows, total] = await Promise.all([
    env.DB.prepare(`${CONTACT_SELECT} ${w} ${order.sql} LIMIT ? OFFSET ?`).bind(...vals, ...order.vals, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM contacts c ${w}`).bind(...vals).first<{ n: number }>(),
  ]);
  return { total: total?.n ?? 0, limit, offset, contacts: (rows.results as never[]).map(publicContact) };
}

/** Which contacts a bulk action is for: ids and/or emails, or everyone matching a filter (minus exclude_ids). */
export interface ContactSelection {
  ids?: number[];
  emails?: string[];
  filter?: ContactFilter;
  exclude_ids?: number[];
}

const MAX_SELECT = 100_000;

async function selectedIds(env: Env, d: ContactSelection) {
  const ids = (d.ids || []).map(Number).filter(Number.isInteger);
  const wanted = [...new Set((d.emails || []).map(normEmail).filter(Boolean))];
  const found = wanted.length ? await contactsByEmail(env, wanted) : new Map<string, ContactRow>();
  ids.push(...[...found.values()].map((c) => c.id));
  if (d.filter && typeof d.filter === 'object') {
    const { w, vals } = await contactWhere(env, d.filter);
    const rows = await env.DB.prepare(`SELECT c.id FROM contacts c ${w} LIMIT ${MAX_SELECT + 1}`).bind(...vals).all<{ id: number }>();
    if (rows.results.length > MAX_SELECT) throw new HttpError(400, `More than ${MAX_SELECT} contacts match; narrow the filter`);
    ids.push(...rows.results.map((r) => r.id));
  }
  const skip = new Set((d.exclude_ids || []).map(Number));
  return { ids: [...new Set(ids)].filter((id) => !skip.has(id)), not_found: wanted.filter((e) => !found.has(e)), hadInput: !!(d.ids?.length || wanted.length || d.filter) };
}

/** Field names in use across contacts, most common first (for filters and sorting). */
export async function contactFields(env: Env) {
  const r = await env.DB.prepare('SELECT j.key AS key, COUNT(*) AS contacts FROM contacts c, json_each(c.fields) j GROUP BY j.key ORDER BY contacts DESC, j.key LIMIT 200').all<{ key: string; contacts: number }>();
  return r.results;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of the selected contacts (or everyone matching a filter): email, name, lists, every field, and email stats. */
export async function exportContacts(env: Env, d: ContactSelection & { sort?: string; dir?: string }) {
  const { ids } = await selectedIds(env, d.ids?.length || d.emails?.length || d.filter ? d : { ...d, filter: {} });
  const rows: ContactRow[] = [];
  for (const c of chunks(ids, 90)) rows.push(...((await env.DB.prepare(`${CONTACT_SELECT} WHERE c.id IN (${qs(c.length)})`).bind(...c).all()).results as never[]));
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const pub = rows.map((r) => publicContact(r as never));
  const keys = [...new Set(pub.flatMap((c) => Object.keys(c.fields)))].sort();
  const head = ['email', 'name', 'lists', ...keys, 'emails_sent', 'last_emailed', 'do_not_send', 'added'];
  const lines = [head.join(',')];
  for (const c of pub) {
    lines.push([c.email, c.name, c.lists.join('; '), ...keys.map((k) => c.fields[k]), c.sent_count, c.last_sent_at, c.do_not_send_scope, c.created_at].map(csvCell).join(','));
  }
  return { csv: lines.join('\r\n') + '\r\n', count: pub.length };
}

export async function getContact(env: Env, id: number) {
  const c = await env.DB.prepare(`${CONTACT_SELECT} WHERE c.id = ?`).bind(id).first<ContactRow>();
  if (!c) throw new HttpError(404, `Contact ${id} not found`);
  const emails = await env.DB.prepare(
    'SELECT id, subject, status, campaign, template_id, send_at, sent_at, open_count, reply_count FROM emails WHERE to_email = ? ORDER BY COALESCE(sent_at, send_at) DESC LIMIT 25',
  )
    .bind(c.email)
    .all<Record<string, unknown>>();
  return {
    ...publicContact(c as never),
    emails: emails.results.map((e) => ({ ...e, send_at: iso(e.send_at as number), sent_at: iso(e.sent_at as number) })),
  };
}

/** Contact id from an id or an email address. */
export async function contactId(env: Env, ref: { id?: number | string; email?: string }): Promise<number> {
  if (ref.id !== undefined && ref.id !== null && ref.id !== '') return Number(ref.id);
  const email = normEmail(ref.email);
  if (!email) throw new HttpError(400, 'Give the contact id or email');
  const c = await env.DB.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>();
  if (!c) throw new HttpError(404, `No contact with email ${email}`);
  return c.id;
}

/**
 * Edit a contact. `fields` replaces the whole set; `set` adds or changes individual fields;
 * `remove` deletes fields by name. Empty values are dropped.
 */
export async function updateContact(
  env: Env,
  id: number,
  d: { name?: string | null; fields?: Record<string, unknown>; set?: Record<string, unknown>; remove?: string[] },
) {
  const c = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first<ContactRow>();
  if (!c) throw new HttpError(404, `Contact ${id} not found`);
  let fields = parseFields(c);
  if (d.set !== undefined) {
    for (const [k, v] of Object.entries(d.set || {})) {
      const key = normKey(k);
      if (!key || EMAIL_KEYS.includes(key) || NAME_KEYS.includes(key)) continue;
      const val = v == null ? '' : String(v).trim();
      if (val) fields[key] = val.slice(0, 2000);
      else delete fields[key];
    }
  }
  for (const k of d.remove || []) delete fields[normKey(k)];
  if (d.fields !== undefined) {
    // Replaces the field set; empty values are dropped.
    fields = {};
    for (const [k, v] of Object.entries(d.fields || {})) {
      const key = normKey(k);
      if (!key || EMAIL_KEYS.includes(key) || NAME_KEYS.includes(key)) continue;
      const val = v == null ? '' : String(v).trim();
      if (val) fields[key] = val.slice(0, 2000);
    }
  }
  await env.DB.prepare('UPDATE contacts SET name = ?, fields = ?, updated_at = ? WHERE id = ?')
    .bind(d.name !== undefined ? String(d.name ?? '').trim() || null : c.name, JSON.stringify(fields), now(), id)
    .run();
  return getContact(env, id);
}

/** Removes contacts (and their list memberships), by id and/or email. Emails already sent to them are kept. */
export async function deleteContacts(env: Env, ids: number[], emails: string[] = [], more: Pick<ContactSelection, 'filter' | 'exclude_ids'> = {}) {
  const sel = await selectedIds(env, { ids, emails, ...more });
  const list = sel.ids;
  if (!list.length) {
    if (sel.hadInput) return { deleted: 0 };
    throw new HttpError(400, 'ids, emails or a filter required');
  }
  let deleted = 0;
  for (const c of chunks(list, 90)) {
    const res = await env.DB.batch([
      env.DB.prepare(`DELETE FROM list_contacts WHERE contact_id IN (${qs(c.length)})`).bind(...c),
      env.DB.prepare(`DELETE FROM contacts WHERE id IN (${qs(c.length)})`).bind(...c),
    ]);
    deleted += res[1].meta.changes;
  }
  return { deleted };
}

/**
 * Add contacts to lists (created if needed) and/or remove them from lists.
 * Contacts are given by id and/or email; emails that aren't contacts yet are reported in not_found
 * (use importContacts to create them).
 */
export async function setContactLists(env: Env, d: ContactSelection & { add?: (string | number)[]; remove?: (string | number)[] }) {
  const sel = await selectedIds(env, d);
  const { ids, not_found } = sel;
  const wanted = d.emails || [];
  if (!ids.length) {
    if (sel.hadInput) return { added: 0, removed: 0, ...(wanted.length ? { not_found } : {}) };
    throw new HttpError(400, 'Give ids, emails or a filter');
  }
  const add = d.add?.length ? await resolveLists(env, d.add, true) : [];
  const remove = d.remove?.length ? await resolveLists(env, d.remove) : [];
  const t = now();
  let added = 0;
  let removed = 0;
  for (const c of chunks(ids, 90)) {
    const stmts = [
      ...add.flatMap((l) => c.map((id) => env.DB.prepare('INSERT OR IGNORE INTO list_contacts (list_id, contact_id, added_at) SELECT ?, id, ? FROM contacts WHERE id = ?').bind(l.id, t, id))),
      ...remove.map((l) => env.DB.prepare(`DELETE FROM list_contacts WHERE list_id = ? AND contact_id IN (${qs(c.length)})`).bind(l.id, ...c)),
    ];
    if (!stmts.length) continue;
    const res = await env.DB.batch(stmts);
    res.forEach((r, i) => (i < add.length * c.length ? (added += r.meta.changes) : (removed += r.meta.changes)));
  }
  return { added, removed, ...(wanted.length ? { not_found } : {}) };
}

// ---------- Sending to lists ----------

/** Narrowing and ordering for a list send. */
export interface RecipientOptions {
  /** Only contacts matching these conditions (same rules as the contacts list). */
  filter?: ContactFilter;
  /** added_to_list (default: the order they joined the lists), or any contact sort key (name, field:<key>, ...). */
  sort?: string;
  /** asc (default for added_to_list) or desc. */
  dir?: string;
}

/**
 * Contacts on any of the lists, each once: those matching the filter, in the chosen order (by default the
 * order they joined the lists; on several lists, the earliest).
 */
export async function listRecipients(env: Env, refs: (string | number)[], opts: RecipientOptions = {}): Promise<ContactRow[]> {
  const lists = await resolveLists(env, refs);
  if (!lists.length) throw new HttpError(400, 'Choose at least one list');
  const { w, vals } = await contactWhere(env, opts.filter && typeof opts.filter === 'object' ? opts.filter : {});
  const byJoin = !opts.sort || opts.sort === 'added_to_list';
  const d = String(opts.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const order = byJoin ? { sql: `ORDER BY m.added ${d}, c.id ${d}`, vals: [] as unknown[] } : orderBy(opts.sort, opts.dir || 'asc');
  const r = await env.DB.prepare(
    `${CONTACT_SELECT} JOIN (SELECT contact_id, MIN(added_at) AS added FROM list_contacts WHERE list_id IN (${qs(lists.length)}) GROUP BY contact_id) m ON m.contact_id = c.id
     ${w} ${order.sql}`,
  )
    .bind(...lists.map((l) => l.id), ...vals, ...order.vals)
    .all<ContactRow>();
  return r.results;
}

/** How many contacts are on the lists, before any filter. */
async function countOnLists(env: Env, refs: (string | number)[]) {
  const lists = await resolveLists(env, refs);
  const r = await env.DB.prepare(`SELECT COUNT(DISTINCT contact_id) AS n FROM list_contacts WHERE list_id IN (${qs(lists.length)})`).bind(...lists.map((l) => l.id)).first<{ n: number }>();
  return r?.n ?? 0;
}

export interface ListSendInput extends RecipientOptions {
  lists: (string | number)[];
  /** Send to at most this many (the first ones in the chosen order who can get it). Re-run a template send to reach the next ones. */
  limit?: number;
  mailbox?: string | number;
  sender?: string | number;
  /** Mailbox group: spread across its mailboxes (always planned by their limits and warm-up). */
  group?: string | number;
  template_id?: string;
  subject?: string;
  body?: string;
  campaign?: string;
  from_name?: string;
  from_email?: string;
  reply_to?: string;
  auto_schedule?: boolean;
  start_at?: string | number;
  send_at?: string | number;
  interval_minutes?: number;
}

/** The message source: a saved template, or an ad-hoc subject/body treated the same way. */
async function messageSource(env: Env, d: ListSendInput, opts: { allowEmpty?: boolean } = {}): Promise<{ tpl: TemplateRow; saved: boolean }> {
  if (d.template_id) return { tpl: await getTemplateRow(env, d.template_id), saved: true };
  const subject = d.subject?.trim() ? d.subject : '';
  const body = d.body?.trim() ? d.body : '';
  if ((!subject || !body) && !opts.allowEmpty) throw new HttpError(400, 'Choose a template, or give a subject and body');
  return {
    saved: false,
    tpl: { id: 0, template_id: '', name: null, subject, body, columns: JSON.stringify(templateColumns(subject, body)), ai_enabled: 0, ai_prompt: null, ai_model: null, ai_on_error: 'retry', ai_system: null, created_at: 0, updated_at: 0 },
  };
}

/** The purpose of the mailbox a list send would go from (null if none chosen yet: any opt-out counts). */
async function sendPurpose(env: Env, d: ListSendInput): Promise<Purpose | null> {
  try {
    if (d.sender !== undefined && d.sender !== null && d.sender !== '') return purposeOf(await getMailbox(env, (await getSenderRow(env, d.sender)).mailbox_id));
    if (d.mailbox !== undefined && d.mailbox !== null && d.mailbox !== '') return purposeOf(await getMailbox(env, d.mailbox));
    if (d.group !== undefined && d.group !== null && d.group !== '') {
      const g = await getGroupRow(env, d.group);
      const ps = (await env.DB.prepare('SELECT DISTINCT purpose FROM mailboxes WHERE group_id = ?').bind(g.id).all<{ purpose: string }>()).results;
      return ps.length === 1 ? purposeOf(ps[0]) : null;
    }
  } catch {
    /* unknown sender/mailbox: the send itself reports it */
  }
  return null;
}

const sendLimit = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be a whole number of contacts');
  return n;
};

type Verdict = { kind: 'send' } | { kind: 'do_not_send' | 'already_received' | 'missing_values'; reason: string };

/** Whether each contact can be sent this message, in order. */
async function verdicts(env: Env, d: ListSendInput, contacts: ContactRow[], tpl: TemplateRow, saved: boolean): Promise<Verdict[]> {
  const emails = contacts.map((c) => c.email);
  const [dnc, taken] = await Promise.all([dncLookup(env, emails, await sendPurpose(env, d)), saved ? templateRecipients(env, tpl.template_id, emails) : Promise.resolve(new Map<string, string>())]);
  return contacts.map((c) => {
    if (dnc.has(c.email)) return { kind: 'do_not_send', reason: 'do-not-send list' };
    const st = taken.get(c.email);
    if (st) return { kind: 'already_received', reason: st === 'scheduled' || st === 'sending' ? 'template already scheduled for this address' : 'already received this template' };
    const missing = missingValues(tpl, contactVars(c));
    if (missing.length) return { kind: 'missing_values', reason: `missing value for ${missing.join(', ')}` };
    return { kind: 'send' };
  });
}

const filtered = (d: RecipientOptions) => !!d.filter && typeof d.filter === 'object' && Object.values(d.filter).some((v) => (Array.isArray(v) ? v.length : v !== undefined && v !== null && v !== ''));

/** Who would get it (in order), who's skipped and why, and which columns the contacts have. Sends nothing. */
export async function previewListSend(env: Env, d: ListSendInput) {
  const contacts = await listRecipients(env, d.lists, d);
  const limit = sendLimit(d.limit);
  // Before a message is written, preview just the audience (only "to" is required).
  const { tpl, saved } = await messageSource(env, d, { allowEmpty: true });
  const v = await verdicts(env, d, contacts, tpl, saved);
  const columns = JSON.parse(tpl.columns) as string[];
  const coverage: Record<string, number> = Object.fromEntries(columns.map((c) => [c, 0]));
  const skipped = { do_not_send: 0, already_received: 0, missing_values: 0 };
  let sample: Record<string, string> | null = null;
  let sendable = 0;
  let held = 0;
  const first: { email: string; name: string | null }[] = [];
  const fieldNames = new Set<string>(['email', 'name']);
  contacts.forEach((c, i) => {
    const vars = contactVars(c);
    if (fieldNames.size < 60) Object.keys(parseFields(c)).forEach((k) => fieldNames.add(k));
    columns.forEach((col) => vars[col] && coverage[col]++);
    const x = v[i];
    if (x.kind !== 'send') return void skipped[x.kind]++;
    if (limit && sendable >= limit) return void held++;
    sendable++;
    if (first.length < 5) first.push({ email: c.email, name: c.name });
    sample ??= vars;
  });
  return {
    contacts: contacts.length, // on the lists and matching the filter
    ...(filtered(d) ? { on_lists: await countOnLists(env, d.lists) } : {}),
    will_send: sendable,
    held_back: held, // could get it, but beyond the limit (a later send reaches them)
    skipped,
    columns,
    coverage, // column -> how many contacts have a value
    fields: [...fieldNames], // variables the contacts provide
    sample, // first contact that would be sent to, for previews
    first, // the first few who'd get it, in send order
  };
}

/**
 * Schedule a message to everyone on the lists (or those matching a filter), in the chosen order. With a saved
 * template, anyone who already has it (queued or sent) is skipped, so re-sending to a growing list only
 * reaches new contacts, and re-sending with a limit reaches the next ones.
 */
export async function sendToLists(env: Env, d: ListSendInput) {
  if (!d.mailbox && !d.sender && !d.group) throw new HttpError(400, 'sender, mailbox or group is required');
  if (d.mailbox) await getMailbox(env, d.mailbox);
  const limit = sendLimit(d.limit);
  let contacts = await listRecipients(env, d.lists, d);
  const matching = contacts.length;
  const { tpl, saved } = await messageSource(env, d);
  const skipped: { to: string; reason: string }[] = [];
  let held = 0;
  if (limit) {
    // Count only people who can get it, so a limit of 200 means 200 emails.
    const v = await verdicts(env, d, contacts, tpl, saved);
    const keep: ContactRow[] = [];
    contacts.forEach((c, i) => {
      const x = v[i];
      if (x.kind !== 'send') skipped.push({ to: c.email, reason: x.reason });
      else if (keep.length < limit) keep.push(c);
      else held++;
    });
    contacts = keep;
  }
  if (contacts.length > MAX_LIST_SEND) throw new HttpError(400, `At most ${MAX_LIST_SEND} contacts per send; narrow it with a filter or a limit`);
  const start = parseTime(d.auto_schedule ? d.start_at : d.send_at);
  const gap = Math.max(0, Number(d.interval_minutes) || 0) * 60_000;
  const inputs: ScheduleInput[] = [];
  contacts.forEach((c, i) => {
    const vars = normVars(contactVars(c));
    const base: Omit<ScheduleInput, 'subject'> = {
      mailbox: d.mailbox,
      sender: d.sender,
      group: d.group,
      to: c.email,
      to_name: c.name || undefined,
      campaign: d.campaign,
      from_name: d.from_name,
      from_email: d.from_email,
      reply_to: d.reply_to,
      send_at: d.auto_schedule ? undefined : start + i * gap,
      metadata: { contact_id: c.id, ...parseFields(c) },
    };
    if (saved) return void inputs.push({ ...base, subject: '', template_id: tpl.template_id, vars });
    const missing = missingValues(tpl, vars);
    if (missing.length) return void skipped.push({ to: c.email, reason: `missing value for ${missing.join(', ')}` });
    const r = renderTemplate(tpl, vars);
    inputs.push({ ...base, subject: r.subject, body_html: r.body_html, body_text: r.body_text });
  });

  const scheduled: Awaited<ReturnType<typeof scheduleEmails>>['scheduled'] = [];
  let first: string | null = null;
  let last: string | null = null;
  for (const part of chunks(inputs, SEND_CHUNK)) {
    const r = (await scheduleEmails(env, part, { auto: !!d.auto_schedule, start_at: d.start_at })) as Awaited<ReturnType<typeof scheduleEmails>> & {
      plan?: { first_send_at: string | null; last_send_at: string | null }[];
    };
    scheduled.push(...r.scheduled);
    r.skipped.forEach((s) => skipped.push({ to: s.to, reason: s.reason }));
    for (const s of r.scheduled) {
      if (!first || s.send_at < first) first = s.send_at;
      if (!last || s.send_at > last) last = s.send_at;
    }
  }
  return { contacts: matching, scheduled: scheduled.length, held_back: held, skipped, first_send_at: first, last_send_at: last, emails: scheduled };
}
