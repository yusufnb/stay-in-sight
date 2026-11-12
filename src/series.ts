import { contactVars, ContactRow, resolveLists } from './contacts';
import { getSenderRow, slugify } from './senders';
import { getGroupRow, scheduleEmails, ScheduleInput } from './service';
import { createTemplate, getTemplateRow, normTemplateId, normVars, TemplateRow, updateTemplate } from './templates';
import { Env, HttpError, normEmail, now } from './util';

/**
 * Series (drip campaigns). Each step is a template sent delay_days after the previous one (step 1: after
 * the contact joins). Everyone on the attached lists is enrolled, including contacts added later, and
 * the cron schedules each person's next step once their previous series email has gone out and the
 * delay has passed. A step added later reaches everyone who hasn't had it, including people who finished.
 */

const DAY = 86_400_000;
const RUN_LIMIT = 500; // emails scheduled per series per run; the rest go on the next run
const MAX_DELAY_DAYS = 365;

export interface SeriesRow {
  id: number;
  name: string;
  description: string | null;
  sender_id: number | null;
  group_id: number | null;
  campaign: string | null;
  stop_on_reply: number;
  active: number;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface StepRow {
  id: number;
  series_id: number;
  position: number;
  template_id: string;
  delay_days: number;
  created_at: number;
  updated_at: number;
}

interface SeriesListRow {
  series_id: number;
  list_id: number;
  only_new: number;
  attached_at: number;
  name?: string;
}

const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
const named = (v: unknown) => v !== undefined && v !== null && v !== '';
const ELIGIBLE = `EXISTS (SELECT 1 FROM series_lists sl JOIN list_contacts lc ON lc.list_id = sl.list_id WHERE sl.series_id = e.series_id AND lc.contact_id = e.contact_id)`;

export async function getSeriesRow(env: Env, ref: string | number): Promise<SeriesRow> {
  const byId = typeof ref === 'number' || /^\d+$/.test(String(ref).trim());
  const s = byId
    ? await env.DB.prepare('SELECT * FROM series WHERE id = ?').bind(Number(ref)).first<SeriesRow>()
    : await env.DB.prepare('SELECT * FROM series WHERE name = ?').bind(String(ref).trim()).first<SeriesRow>();
  if (!s) throw new HttpError(404, `Series not found: ${ref}`);
  return s;
}

async function stepRows(env: Env, seriesId: number) {
  return (await env.DB.prepare('SELECT * FROM series_steps WHERE series_id = ? ORDER BY position, id').bind(seriesId).all<StepRow>()).results;
}

/** Renumber steps 1..n in their current order. */
async function renumber(env: Env, seriesId: number) {
  const steps = await stepRows(env, seriesId);
  const stale = steps.map((st, i) => [st, i + 1] as const).filter(([st, p]) => st.position !== p);
  if (stale.length) await env.DB.batch(stale.map(([st, p]) => env.DB.prepare('UPDATE series_steps SET position = ? WHERE id = ?').bind(p, st.id)));
}

// ---------- reading ----------

/** Where each enrollment stands: in progress, finished every current step, stopped, or no longer on a list. */
async function enrollmentStats(env: Env, s: SeriesRow, stepCount: number) {
  const rows = (
    await env.DB.prepare(
      `SELECT e.status, e.waiting, ${ELIGIBLE} AS eligible,
         (SELECT COUNT(*) FROM series_deliveries d JOIN series_steps st ON st.id = d.step_id WHERE d.enrollment_id = e.id) AS done
       FROM series_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.series_id = ?`,
    )
      .bind(s.id)
      .all<{ status: string; waiting: number; eligible: number; done: number }>()
  ).results;
  const out = { enrolled: rows.length, in_progress: 0, completed: 0, stopped: 0, not_on_list: 0 };
  for (const r of rows) {
    if (r.status === 'stopped') out.stopped++;
    else if (!r.eligible) out.not_on_list++;
    else if (!r.waiting && r.done >= stepCount) out.completed++;
    else out.in_progress++;
  }
  return out;
}

async function publicSeries(env: Env, s: SeriesRow, detail = true) {
  const steps = await stepRows(env, s.id);
  const [lists, templates, stepStats, sender, group, stats] = await Promise.all([
    env.DB.prepare('SELECT sl.*, l.name FROM series_lists sl JOIN lists l ON l.id = sl.list_id WHERE sl.series_id = ? ORDER BY l.name COLLATE NOCASE')
      .bind(s.id)
      .all<SeriesListRow>(),
    steps.length
      ? env.DB.prepare(`SELECT * FROM templates WHERE template_id IN (${steps.map(() => '?').join(',')})`).bind(...steps.map((st) => st.template_id)).all<TemplateRow>()
      : Promise.resolve({ results: [] as TemplateRow[] }),
    env.DB.prepare(
      `SELECT series_step_id AS step_id, COUNT(*) AS total,
         SUM(status IN ('sent','bounced')) AS sent, SUM(status IN ('scheduled','sending')) AS scheduled,
         SUM(open_count > 0) AS opened, SUM(reply_count > 0) AS replied
       FROM emails WHERE series_id = ? GROUP BY series_step_id`,
    )
      .bind(s.id)
      .all<{ step_id: number; total: number; sent: number; scheduled: number; opened: number; replied: number }>(),
    s.sender_id ? env.DB.prepare('SELECT s.id, s.key, s.label, m.email AS mailbox FROM senders s JOIN mailboxes m ON m.id = s.mailbox_id WHERE s.id = ?').bind(s.sender_id).first() : null,
    s.group_id ? env.DB.prepare('SELECT id, name FROM mailbox_groups WHERE id = ?').bind(s.group_id).first() : null,
    detail ? enrollmentStats(env, s, steps.length) : null,
  ]);
  const tpl = new Map(templates.results.map((t) => [t.template_id, t]));
  const st = new Map(stepStats.results.map((x) => [x.step_id, x]));
  let day = 0;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    active: !!s.active,
    sender,
    group,
    campaign: s.campaign || s.name,
    stop_on_reply: !!s.stop_on_reply,
    lists: lists.results.map((l) => ({ id: l.list_id, name: l.name, only_new: !!l.only_new, attached_at: iso(l.attached_at) })),
    steps: steps.map((x, i) => {
      day += x.delay_days;
      const t = tpl.get(x.template_id);
      const k = st.get(x.id);
      return {
        id: x.id,
        position: i + 1,
        template_id: x.template_id,
        template_exists: !!t,
        name: t?.name ?? null,
        subject: t?.subject ?? null,
        delay_days: x.delay_days,
        /** Days after joining, if every step goes out on time. */
        day,
        stats: { sent: k?.sent ?? 0, scheduled: k?.scheduled ?? 0, opened: k?.opened ?? 0, replied: k?.replied ?? 0 },
      };
    }),
    ...(stats ? { stats } : {}),
    last_run_at: iso(s.last_run_at),
    last_error: s.last_error,
    created_at: iso(s.created_at),
    updated_at: iso(s.updated_at),
  };
}

export async function listSeries(env: Env) {
  const rows = (await env.DB.prepare('SELECT * FROM series ORDER BY name COLLATE NOCASE').all<SeriesRow>()).results;
  return Promise.all(rows.map((s) => publicSeries(env, s)));
}

export async function getSeries(env: Env, ref: string | number) {
  return publicSeries(env, await getSeriesRow(env, ref));
}

// ---------- writing ----------

export interface ListRef {
  list: string | number;
  /** Only contacts added to the list from now on (not the ones already on it). */
  only_new?: boolean;
}

export interface SeriesInput {
  name?: string;
  description?: string | null;
  /** Sender key or id (its mailbox sends), or */
  sender?: string | number | null;
  /** a mailbox group (name or id): spread across its mailboxes. */
  group?: string | number | null;
  campaign?: string | null;
  stop_on_reply?: boolean;
  active?: boolean;
  /** Lists to enroll (names/ids, or {list, only_new}). Replaces the attached lists. */
  lists?: (string | number | ListRef)[];
  /** Only when creating: the steps, in order. */
  steps?: StepInput[];
}

export interface StepInput {
  /** An existing template, or give subject + body to create one for this step. */
  template_id?: string;
  subject?: string;
  body?: string;
  name?: string;
  /** Step 1: days after joining. Later steps: days after the previous email went out. */
  delay_days?: number;
  /** 1-based; default: at the end. */
  position?: number;
}

function cleanName(v: unknown) {
  const name = String(v ?? '').trim();
  if (!name || name.length > 80) throw new HttpError(400, 'name must be 1-80 characters');
  if (/^\d+$/.test(name)) throw new HttpError(400, "name can't be only digits (ids are numbers)");
  return name;
}

function cleanDelay(v: unknown) {
  const n = Number(v ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DELAY_DAYS) throw new HttpError(400, `delay_days must be a whole number from 0 to ${MAX_DELAY_DAYS}`);
  return n;
}

/** Sender or group: exactly one. */
async function sendsAs(env: Env, d: SeriesInput, current?: SeriesRow) {
  const hasS = d.sender !== undefined;
  const hasG = d.group !== undefined;
  let sender_id = current?.sender_id ?? null;
  let group_id = current?.group_id ?? null;
  if (hasS) sender_id = named(d.sender) ? (await getSenderRow(env, d.sender!)).id : null;
  if (hasG) group_id = named(d.group) ? (await getGroupRow(env, d.group!)).id : null;
  if (hasS && sender_id && !hasG) group_id = null;
  if (hasG && group_id && !hasS) sender_id = null;
  if (sender_id && group_id) throw new HttpError(400, 'Give a sender or a group, not both');
  if (!sender_id && !group_id) throw new HttpError(400, 'A series needs a sender or a mailbox group to send from');
  return { sender_id, group_id };
}

async function setLists(env: Env, seriesId: number, refs: (string | number | ListRef)[]) {
  if (!Array.isArray(refs)) throw new HttpError(400, 'lists must be a list of list names or ids');
  const items = refs.map((r) => (typeof r === 'object' && r !== null ? r : { list: r }));
  const lists = await resolveLists(env, items.map((i) => i.list));
  const onlyNew = new Map<number, boolean>();
  for (const it of items) {
    const [l] = await resolveLists(env, [it.list]);
    onlyNew.set(l.id, !!it.only_new);
  }
  const current = new Map(
    (await env.DB.prepare('SELECT * FROM series_lists WHERE series_id = ?').bind(seriesId).all<SeriesListRow>()).results.map((r) => [r.list_id, r]),
  );
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const l of lists) {
    const cur = current.get(l.id);
    const on = onlyNew.get(l.id) ? 1 : 0;
    if (!cur) stmts.push(env.DB.prepare('INSERT INTO series_lists (series_id, list_id, only_new, attached_at) VALUES (?, ?, ?, ?)').bind(seriesId, l.id, on, t));
    else if (cur.only_new !== on) stmts.push(env.DB.prepare('UPDATE series_lists SET only_new = ? WHERE series_id = ? AND list_id = ?').bind(on, seriesId, l.id));
  }
  const keep = new Set(lists.map((l) => l.id));
  for (const id of current.keys()) if (!keep.has(id)) stmts.push(env.DB.prepare('DELETE FROM series_lists WHERE series_id = ? AND list_id = ?').bind(seriesId, id));
  if (stmts.length) await env.DB.batch(stmts);
}

export async function createSeries(env: Env, d: SeriesInput) {
  const name = cleanName(d.name);
  if (await env.DB.prepare('SELECT 1 FROM series WHERE name = ?').bind(name).first()) throw new HttpError(409, `A series named "${name}" already exists`);
  const { sender_id, group_id } = await sendsAs(env, d);
  const t = now();
  const r = await env.DB.prepare(
    'INSERT INTO series (name, description, sender_id, group_id, campaign, stop_on_reply, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(name, String(d.description ?? '').trim() || null, sender_id, group_id, String(d.campaign ?? '').trim() || null, d.stop_on_reply ? 1 : 0, d.active === false ? 0 : 1, t, t)
    .run();
  const id = Number(r.meta.last_row_id);
  if (d.lists) await setLists(env, id, d.lists);
  for (const st of d.steps || []) await addStep(env, id, st);
  return getSeries(env, id);
}

export async function updateSeries(env: Env, ref: string | number, d: SeriesInput) {
  const s = await getSeriesRow(env, ref);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.name !== undefined) {
    const name = cleanName(d.name);
    const other = await env.DB.prepare('SELECT id FROM series WHERE name = ?').bind(name).first<{ id: number }>();
    if (other && other.id !== s.id) throw new HttpError(409, `A series named "${name}" already exists`);
    sets.push('name = ?');
    vals.push(name);
  }
  if (d.description !== undefined) (sets.push('description = ?'), vals.push(String(d.description ?? '').trim() || null));
  if (d.campaign !== undefined) (sets.push('campaign = ?'), vals.push(String(d.campaign ?? '').trim() || null));
  if (d.stop_on_reply !== undefined) (sets.push('stop_on_reply = ?'), vals.push(d.stop_on_reply ? 1 : 0));
  if (d.active !== undefined) (sets.push('active = ?'), vals.push(d.active ? 1 : 0));
  if (d.sender !== undefined || d.group !== undefined) {
    const sa = await sendsAs(env, d, s);
    sets.push('sender_id = ?', 'group_id = ?');
    vals.push(sa.sender_id, sa.group_id);
  }
  if (sets.length) await env.DB.prepare(`UPDATE series SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now(), s.id).run();
  if (d.lists !== undefined) await setLists(env, s.id, d.lists);
  return getSeries(env, s.id);
}

/** Deletes the series and cancels its emails that haven't gone out. Sent emails and templates stay. */
export async function deleteSeries(env: Env, ref: string | number) {
  const s = await getSeriesRow(env, ref);
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE emails SET status = 'cancelled', status_reason = 'series deleted' WHERE series_id = ? AND status = 'scheduled'").bind(s.id),
    env.DB.prepare('DELETE FROM series_deliveries WHERE enrollment_id IN (SELECT id FROM series_enrollments WHERE series_id = ?)').bind(s.id),
    env.DB.prepare('DELETE FROM series_enrollments WHERE series_id = ?').bind(s.id),
    env.DB.prepare('DELETE FROM series_lists WHERE series_id = ?').bind(s.id),
    env.DB.prepare('DELETE FROM series_steps WHERE series_id = ?').bind(s.id),
    env.DB.prepare('DELETE FROM series WHERE id = ?').bind(s.id),
  ]);
  return { deleted: s.name, cancelled: res[0].meta.changes };
}

/** A free template_id for a new step of this series. */
async function stepTemplateId(env: Env, s: SeriesRow) {
  const base = slugify(s.name).slice(0, 50) || 'series';
  for (let i = (await stepRows(env, s.id)).length + 1; ; i++) {
    const id = `${base}-${i}`;
    if (!(await env.DB.prepare('SELECT 1 FROM templates WHERE template_id = ?').bind(id).first())) return id;
  }
}

/** Add a step: an existing template, or a new one from subject + body. */
export async function addStep(env: Env, ref: string | number, d: StepInput) {
  const s = await getSeriesRow(env, ref);
  const steps = await stepRows(env, s.id);
  // Validate everything before creating a template, so a rejected step leaves nothing behind.
  const delay = cleanDelay(d.delay_days ?? (steps.length ? 3 : 0));
  const pos = d.position === undefined ? steps.length + 1 : Math.min(Math.max(1, Math.floor(Number(d.position)) || 1), steps.length + 1);
  let templateId: string;
  if (named(d.template_id)) {
    templateId = (await getTemplateRow(env, normTemplateId(d.template_id))).template_id;
    if (steps.some((x) => x.template_id === templateId)) throw new HttpError(409, `Template "${templateId}" is already a step in this series`);
  } else {
    if (!named(d.subject) || !named(d.body)) throw new HttpError(400, 'Give a template_id, or a subject and body for a new template');
    templateId = (await createTemplate(env, { template_id: await stepTemplateId(env, s), name: d.name || `${s.name}: step ${steps.length + 1}`, subject: d.subject!, body: d.body! })).template_id;
  }
  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE series_steps SET position = position + 1 WHERE series_id = ? AND position >= ?').bind(s.id, pos),
    env.DB.prepare('INSERT INTO series_steps (series_id, position, template_id, delay_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(s.id, pos, templateId, delay, t, t),
    env.DB.prepare('UPDATE series SET updated_at = ? WHERE id = ?').bind(t, s.id),
  ]);
  await renumber(env, s.id);
  return getSeries(env, s.id);
}

async function stepOf(env: Env, s: SeriesRow, stepId: string | number) {
  const st = await env.DB.prepare('SELECT * FROM series_steps WHERE id = ? AND series_id = ?').bind(Number(stepId), s.id).first<StepRow>();
  if (!st) throw new HttpError(404, `Step ${stepId} not found in series "${s.name}"`);
  return st;
}

/** Change a step's delay, position or template. subject/body edit the template itself. */
export async function updateStep(env: Env, ref: string | number, stepId: string | number, d: StepInput) {
  const s = await getSeriesRow(env, ref);
  const st = await stepOf(env, s, stepId);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.delay_days !== undefined) (sets.push('delay_days = ?'), vals.push(cleanDelay(d.delay_days)));
  if (named(d.template_id) && normTemplateId(d.template_id) !== st.template_id) {
    const tid = (await getTemplateRow(env, normTemplateId(d.template_id))).template_id;
    if ((await stepRows(env, s.id)).some((x) => x.template_id === tid)) throw new HttpError(409, `Template "${tid}" is already a step in this series`);
    sets.push('template_id = ?');
    vals.push(tid);
  } else if (d.subject !== undefined || d.body !== undefined || d.name !== undefined) {
    await updateTemplate(env, st.template_id, { subject: d.subject, body: d.body, name: d.name });
  }
  if (sets.length) await env.DB.prepare(`UPDATE series_steps SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now(), st.id).run();
  if (d.position !== undefined) {
    const steps = (await stepRows(env, s.id)).filter((x) => x.id !== st.id);
    const pos = Math.min(Math.max(1, Math.floor(Number(d.position)) || 1), steps.length + 1);
    steps.splice(pos - 1, 0, st);
    await env.DB.batch(steps.map((x, i) => env.DB.prepare('UPDATE series_steps SET position = ? WHERE id = ?').bind(i + 1, x.id)));
  }
  return getSeries(env, s.id);
}

/** Remove a step. Its emails that haven't gone out are cancelled; people move on to the next step. The template stays. */
export async function deleteStep(env: Env, ref: string | number, stepId: string | number) {
  const s = await getSeriesRow(env, ref);
  const st = await stepOf(env, s, stepId);
  await env.DB.batch([
    env.DB.prepare("UPDATE emails SET status = 'cancelled', status_reason = 'series step removed' WHERE series_step_id = ? AND status = 'scheduled'").bind(st.id),
    env.DB.prepare('DELETE FROM series_steps WHERE id = ?').bind(st.id),
  ]);
  await renumber(env, s.id);
  return getSeries(env, s.id);
}

// ---------- enrollments ----------

export async function listEnrollments(env: Env, ref: string | number, f: { status?: string; q?: string; limit?: number; offset?: number } = {}) {
  const s = await getSeriesRow(env, ref);
  const steps = await stepRows(env, s.id);
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const where = ['e.series_id = ?'];
  const vals: unknown[] = [s.id];
  if (f.q) (where.push('(c.email LIKE ? OR c.name LIKE ?)'), vals.push(`%${f.q}%`, `%${f.q}%`));
  const rows = (
    await env.DB.prepare(
      `SELECT e.*, c.email, c.name, ${ELIGIBLE} AS eligible, em.status AS last_status, em.send_at AS last_send_at
       FROM series_enrollments e JOIN contacts c ON c.id = e.contact_id LEFT JOIN emails em ON em.id = e.last_email_id
       WHERE ${where.join(' AND ')} ORDER BY e.enrolled_at DESC, e.id DESC`,
    )
      .bind(...vals)
      .all<{ id: number; contact_id: number; email: string; name: string | null; status: string; stop_reason: string | null; waiting: number; last_at: number | null; enrolled_at: number; eligible: number; last_status: string | null; last_send_at: number | null }>()
  ).results;
  const ids = rows.map((r) => r.id);
  const delivered = new Map<number, Set<number>>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const ds = await env.DB.prepare(`SELECT enrollment_id, step_id FROM series_deliveries WHERE enrollment_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ enrollment_id: number; step_id: number }>();
    for (const d of ds.results) delivered.set(d.enrollment_id, (delivered.get(d.enrollment_id) || new Set()).add(d.step_id));
  }
  const shaped = rows.map((r) => {
    const got = delivered.get(r.id) || new Set();
    const done = steps.filter((x) => got.has(x.id)).length;
    const next = steps.find((x) => !got.has(x.id)) || null;
    const state = r.status === 'stopped' ? 'stopped' : !r.eligible ? 'not_on_list' : r.waiting ? 'in_progress' : next ? 'in_progress' : 'completed';
    const base = r.last_at ?? r.enrolled_at;
    return {
      id: r.id,
      contact_id: r.contact_id,
      email: r.email,
      name: r.name,
      state,
      stop_reason: r.stop_reason,
      steps_done: done,
      steps_total: steps.length,
      /** The step being sent now (waiting) or next, and when it is due. */
      next_step: r.waiting ? null : next ? { position: steps.indexOf(next) + 1, due_at: iso(Math.max(base + next.delay_days * DAY, now())) } : null,
      sending: r.waiting ? { status: r.last_status, send_at: iso(r.last_send_at) } : null,
      enrolled_at: iso(r.enrolled_at),
      last_at: iso(r.last_at),
    };
  });
  const filtered = f.status ? shaped.filter((x) => x.state === f.status) : shaped;
  return { total: filtered.length, enrollments: filtered.slice(offset, offset + limit) };
}

/** Stop someone's series, or let them continue where they left off. */
export async function setEnrollment(env: Env, ref: string | number, enrollmentId: string | number, d: { status: 'active' | 'stopped' }) {
  const s = await getSeriesRow(env, ref);
  if (d.status !== 'active' && d.status !== 'stopped') throw new HttpError(400, 'status must be active or stopped');
  const e = await env.DB.prepare('SELECT * FROM series_enrollments WHERE id = ? AND series_id = ?').bind(Number(enrollmentId), s.id).first<{ id: number; last_email_id: number | null }>();
  if (!e) throw new HttpError(404, `Enrollment ${enrollmentId} not found`);
  const stmts = [
    env.DB.prepare('UPDATE series_enrollments SET status = ?, stop_reason = ?, updated_at = ? WHERE id = ?').bind(d.status, d.status === 'stopped' ? 'stopped by hand' : null, now(), e.id),
  ];
  if (d.status === 'stopped' && e.last_email_id) {
    stmts.push(env.DB.prepare("UPDATE emails SET status = 'cancelled', status_reason = 'series stopped for this contact' WHERE id = ? AND status = 'scheduled'").bind(e.last_email_id));
  }
  await env.DB.batch(stmts);
  return (await listEnrollments(env, s.id, {})).enrollments.find((x) => x.id === e.id);
}

// ---------- the engine ----------

/** Run every active series (cron), or one series now. */
export async function runSeries(env: Env, only?: string | number) {
  const list = only !== undefined ? [await getSeriesRow(env, only)] : (await env.DB.prepare('SELECT * FROM series WHERE active = 1').all<SeriesRow>()).results;
  const total = { series: 0, enrolled: 0, scheduled: 0, skipped: 0, stopped: 0 };
  for (const s of list) {
    if (!s.active && only === undefined) continue;
    try {
      const r = await runOne(env, s);
      total.series++;
      for (const k of ['enrolled', 'scheduled', 'skipped', 'stopped'] as const) total[k] += r[k];
      await env.DB.prepare('UPDATE series SET last_run_at = ?, last_error = ? WHERE id = ?').bind(now(), r.error || null, s.id).run();
    } catch (err) {
      await env.DB.prepare('UPDATE series SET last_run_at = ?, last_error = ? WHERE id = ?').bind(now(), String((err as Error).message).slice(0, 500), s.id).run();
    }
  }
  return total;
}

async function runOne(env: Env, s: SeriesRow) {
  const t = now();
  const out = { enrolled: 0, scheduled: 0, skipped: 0, stopped: 0, error: '' as string };

  // 1. Enroll everyone on the attached lists (only_new: just people added after the list was attached).
  const enr = await env.DB.prepare(
    `INSERT OR IGNORE INTO series_enrollments (series_id, contact_id, status, waiting, enrolled_at, updated_at)
     SELECT DISTINCT ?, lc.contact_id, 'active', 0, ?, ? FROM series_lists sl JOIN list_contacts lc ON lc.list_id = sl.list_id
     WHERE sl.series_id = ? AND (sl.only_new = 0 OR lc.added_at > sl.attached_at)`,
  )
    .bind(s.id, t, t, s.id)
    .run();
  out.enrolled = enr.meta.changes;

  // 2. Settle people whose latest series email is done: next step counts from when it went out.
  const settled = (
    await env.DB.prepare(
      `SELECT e.id, em.status, em.status_reason, em.sent_at FROM series_enrollments e LEFT JOIN emails em ON em.id = e.last_email_id
       WHERE e.series_id = ? AND e.waiting = 1 AND (em.id IS NULL OR em.status NOT IN ('scheduled','sending'))`,
    )
      .bind(s.id)
      .all<{ id: number; status: string | null; status_reason: string | null; sent_at: number | null }>()
  ).results;
  const stmts: D1PreparedStatement[] = [];
  for (const r of settled) {
    const stop = r.status === 'bounced' ? 'bounced' : r.status === 'skipped' && /do-not-send/.test(r.status_reason || '') ? 'do-not-send' : null;
    if (stop) {
      out.stopped++;
      stmts.push(env.DB.prepare("UPDATE series_enrollments SET waiting = 0, status = 'stopped', stop_reason = ?, last_at = ?, updated_at = ? WHERE id = ?").bind(stop, t, t, r.id));
    } else {
      stmts.push(env.DB.prepare('UPDATE series_enrollments SET waiting = 0, last_at = ?, updated_at = ? WHERE id = ?').bind(r.sent_at || t, t, r.id));
    }
  }
  if (s.stop_on_reply) {
    const replied = `SELECT c.id FROM contacts c WHERE EXISTS (SELECT 1 FROM emails em WHERE em.series_id = ? AND em.to_email = c.email AND em.reply_count > 0)`;
    stmts.push(
      env.DB.prepare(
        `UPDATE emails SET status = 'cancelled', status_reason = 'replied, and this series stops on reply'
         WHERE series_id = ? AND status = 'scheduled' AND to_email IN (SELECT c.email FROM contacts c WHERE c.id IN (${replied}))`,
      ).bind(s.id, s.id),
      env.DB.prepare(`UPDATE series_enrollments SET status = 'stopped', stop_reason = 'replied', waiting = 0, updated_at = ? WHERE series_id = ? AND status = 'active' AND contact_id IN (${replied})`).bind(t, s.id, s.id),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) {
    const res = await env.DB.batch(stmts.slice(i, i + 100));
    if (s.stop_on_reply && i + 100 >= stmts.length) out.stopped += res[res.length - 1].meta.changes;
  }

  // 3. Who is due: their first step they haven't had, once its delay has passed, while still on a list.
  const due = (
    await env.DB.prepare(
      `SELECT e.id AS enrollment_id, c.*, st.id AS step_id, st.template_id, st.position
       FROM series_enrollments e
       JOIN contacts c ON c.id = e.contact_id
       JOIN series_steps st ON st.id = (
         SELECT s2.id FROM series_steps s2 WHERE s2.series_id = e.series_id
           AND NOT EXISTS (SELECT 1 FROM series_deliveries d WHERE d.enrollment_id = e.id AND d.step_id = s2.id)
         ORDER BY s2.position, s2.id LIMIT 1)
       WHERE e.series_id = ? AND e.status = 'active' AND e.waiting = 0
         AND COALESCE(e.last_at, e.enrolled_at) + st.delay_days * ${DAY} <= ? AND ${ELIGIBLE}
       ORDER BY COALESCE(e.last_at, e.enrolled_at), e.id LIMIT ?`,
    )
      .bind(s.id, t, RUN_LIMIT)
      .all<ContactRow & { enrollment_id: number; step_id: number; template_id: string; position: number }>()
  ).results;
  if (!due.length) return out;

  // A step whose template was deleted can't go out: report it and leave those people waiting.
  const tids = [...new Set(due.map((r) => r.template_id))];
  const existing = new Set(
    (await env.DB.prepare(`SELECT template_id FROM templates WHERE template_id IN (${tids.map(() => '?').join(',')})`).bind(...tids).all<{ template_id: string }>()).results.map((x) => x.template_id),
  );
  const missing = tids.filter((x) => !existing.has(x));
  if (missing.length) out.error = `Template ${missing.map((x) => `"${x}"`).join(', ')} no longer exists; people on that step are waiting. Edit the step to use another template.`;
  const rows = due.filter((r) => existing.has(r.template_id));
  if (!rows.length) return out;

  const from: Partial<ScheduleInput> = s.group_id ? { group: s.group_id } : { sender: s.sender_id! };
  const inputs: ScheduleInput[] = rows.map((r) => {
    const vars = normVars(contactVars(r));
    return {
      ...from,
      to: r.email,
      to_name: r.name || undefined,
      subject: '',
      template_id: r.template_id,
      vars,
      campaign: s.campaign || s.name,
      metadata: { contact_id: r.id, series: s.name, series_step: r.position },
    } as ScheduleInput;
  });
  const res = await scheduleEmails(env, inputs, { auto: true, tags: rows.map((r) => ({ series_id: s.id, series_step_id: r.step_id })) });
  const byTo = new Map(res.scheduled.map((x) => [x.to, x]));
  const skippedBy = new Map(res.skipped.map((x) => [normEmail(x.to), x.reason]));
  const writes: D1PreparedStatement[] = [];
  for (const r of rows) {
    const sch = byTo.get(r.email);
    if (sch) {
      out.scheduled++;
      writes.push(
        env.DB.prepare("INSERT OR IGNORE INTO series_deliveries (enrollment_id, step_id, email_id, outcome, created_at) VALUES (?, ?, ?, 'scheduled', ?)").bind(r.enrollment_id, r.step_id, sch.id, t),
        env.DB.prepare('UPDATE series_enrollments SET waiting = 1, last_email_id = ?, updated_at = ? WHERE id = ?').bind(sch.id, t, r.enrollment_id),
      );
      continue;
    }
    const reason = skippedBy.get(r.email) || 'not scheduled';
    if (/do-not-send/.test(reason)) {
      out.stopped++;
      writes.push(env.DB.prepare("UPDATE series_enrollments SET status = 'stopped', stop_reason = 'do-not-send', updated_at = ? WHERE id = ?").bind(t, r.enrollment_id));
      continue;
    }
    // Already had this template, or missing a variable: skip the step and move on.
    out.skipped++;
    writes.push(
      env.DB.prepare("INSERT OR IGNORE INTO series_deliveries (enrollment_id, step_id, outcome, reason, created_at) VALUES (?, ?, 'skipped', ?, ?)").bind(r.enrollment_id, r.step_id, reason, t),
      env.DB.prepare('UPDATE series_enrollments SET last_at = ?, updated_at = ? WHERE id = ?').bind(t, t, r.enrollment_id),
    );
  }
  for (let i = 0; i < writes.length; i += 100) await env.DB.batch(writes.slice(i, i + 100));
  return out;
}
