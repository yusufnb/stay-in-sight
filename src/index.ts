import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { checkPasscode, isAuthed, isSetUp, makeSession, PASSCODE_MIN, requireAuth, SESSION_COOKIE, setPasscode } from './auth';
import { exchangeCode, googleAuthUrl } from './google';
import { handleMcp } from './mcp';
import { processDue, sendReply } from './sender';
import * as svc from './service';
import * as tmpl from './templates';
import * as contacts from './contacts';
import * as senders from './senders';
import * as groups from './groups';
import * as series from './series';
import { activity } from './activity';
import { DEFAULT_SYSTEM, previewPersonalization, systemSuffix } from './personalize';
import { runSeries } from './series';
import { DNC_SCOPE_LABELS, DNC_SCOPES, optOutScope, PURPOSE_KEYS, PURPOSES, purposeOf } from './purpose';
import * as cat from './categorize';
import { DEFAULT_APP_NAME, withConfig } from './config';
import { readSettings, saveSettings } from './settings';
import { applyCategory, deliverWebhooks, handlePush, recategorize, renewWatches, syncAll, syncMailbox } from './sync';
import { loginPage, appPage, safeNext, setupPage, unsubscribePage } from './ui';
import { openApiSpec, swaggerPage } from './openapi';
import { baseUrl, Env, getSetting, hmacHex, HttpError, now, regenerateWebhookToken, safeEqual, sesWebhookToken, webhookToken } from './util';
import { handleInboundEmail } from './inbound';
import { handleSesWebhook } from './ses-events';
import { onPlatform, platformRoutes, STORAGE_FULL, storageFull } from './platform';
export { Scheduler } from './scheduler';

type App = { Bindings: Env };
const app = new Hono<App>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: err.message || 'Internal error' }, 500);
});

// ---------------- Public ----------------

app.get('/health', (c) => c.json({ ok: true }));
// The SleekSky platform: health check, platform sign-in, and its scheduled calls (src/platform.ts).
app.route('/', platformRoutes);

const appName = (env: Env) => env.APP_NAME?.trim() || DEFAULT_APP_NAME;

app.get('/login', (c) => (isSetUp(c.env) ? c.html(loginPage(undefined, appName(c.env), safeNext(c.req.query('next')), onPlatform(c.env))) : c.redirect('/setup')));

// First run: the first admin chooses the passcode. On the SleekSky platform, only an account owner or staff member who
// signed in through the platform (and so already has a session here) can do this; self-hosted, the first visitor does.
const mayDoSetup = async (c: Parameters<typeof isAuthed>[0]) => !onPlatform(c.env) || (await isAuthed(c));
const sessionCookie = (url: string) => ({ httpOnly: true, secure: new URL(url).protocol === 'https:', sameSite: 'Lax' as const, path: '/', maxAge: 30 * 24 * 3600 });
app.get('/setup', async (c) => {
  if (isSetUp(c.env)) return c.redirect('/login');
  if (!(await mayDoSetup(c))) return c.redirect('/auth/platform?next=/setup');
  return c.html(setupPage(undefined, appName(c.env), PASSCODE_MIN));
});
app.post('/setup', async (c) => {
  if (isSetUp(c.env)) return c.redirect('/login');
  if (!(await mayDoSetup(c))) return c.redirect('/auth/platform?next=/setup');
  const form = await c.req.parseBody();
  const pc = String(form.passcode || ''), again = String(form.again || '');
  if (pc !== again) return c.html(setupPage('The two passcodes are different.', appName(c.env), PASSCODE_MIN), 400);
  try {
    await setPasscode(c.env, pc);
  } catch (e) {
    return c.html(setupPage((e as Error).message, appName(c.env), PASSCODE_MIN), 400);
  }
  setCookie(c, SESSION_COOKIE, await makeSession(c.env), sessionCookie(c.req.url));
  await baseUrl(c.env, c.req.url);
  return c.redirect('/');
});
app.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  if (!(await checkPasscode(c.env, String(form.passcode || '')))) return c.html(loginPage('Wrong passcode', appName(c.env), next), 401);
  setCookie(c, SESSION_COOKIE, await makeSession(c.env), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
  await baseUrl(c.env, c.req.url); // remember public URL for pixel/unsubscribe links
  return c.redirect(next);
});
app.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/login');
});

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));

app.get('/t/:file', (c) => {
  const token = c.req.param('file').replace(/\.gif$/, '');
  const ip = c.req.header('cf-connecting-ip') || null;
  const ua = c.req.header('user-agent')?.slice(0, 300) || null;
  c.executionCtx.waitUntil(recordOpen(c.env, token, ip, ua));
  return new Response(GIF, {
    headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0', pragma: 'no-cache' },
  });
});

async function recordOpen(env: Env, token: string, ip: string | null, ua: string | null) {
  const e = await env.DB.prepare("SELECT id FROM emails WHERE track_token = ? AND status IN ('sent','bounced')").bind(token).first<{ id: number }>();
  if (!e) return;
  const t = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO opens (email_id, opened_at, ip, user_agent) VALUES (?, ?, ?, ?)').bind(e.id, t, ip, ua),
    env.DB.prepare('UPDATE emails SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, ?), last_opened_at = ? WHERE id = ?').bind(t, t, e.id),
  ]);
}

async function unsubscribe(env: Env, token: string) {
  const e = await env.DB.prepare('SELECT e.id, e.to_email, m.purpose FROM emails e JOIN mailboxes m ON m.id = e.mailbox_id WHERE e.track_token = ?')
    .bind(token)
    .first<{ id: number; to_email: string; purpose: string }>();
  if (!e) return null;
  // Unsubscribing from a newsletter stops newsletters; from cold outreach, outreach and newsletters.
  await svc.dncAdd(env, [e.to_email], 'Unsubscribe link', 'unsubscribe', e.id, optOutScope(purposeOf(e)));
  return e.to_email;
}
app.get('/u/:token', async (c) => {
  const e = await c.env.DB.prepare('SELECT to_email FROM emails WHERE track_token = ?').bind(c.req.param('token')).first<{ to_email: string }>();
  return c.html(unsubscribePage(e ? 'confirm' : 'invalid', e?.to_email));
});
app.post('/u/:token', async (c) => {
  // Handles both RFC 8058 one-click (List-Unsubscribe=One-Click) and the confirm form.
  const email = await unsubscribe(c.env, c.req.param('token'));
  return c.html(unsubscribePage(email ? 'done' : 'invalid', email || undefined));
});

// OAuth state = "<exp>.<hmac>" so the callback can be public.
async function makeState(env: Env) {
  const exp = now() + 15 * 60_000;
  return `${exp}.${(await hmacHex(env.SESSION_SECRET!, `oauth:${exp}`)).slice(0, 32)}`;
}
async function checkState(env: Env, state: string) {
  const [exp, sig] = state.split('.');
  return !!exp && Number(exp) > now() && safeEqual(sig || '', (await hmacHex(env.SESSION_SECRET!, `oauth:${exp}`)).slice(0, 32));
}

app.get('/oauth/google/start', requireAuth('page'), async (c) => {
  const base = await baseUrl(c.env, c.req.url);
  return c.redirect(googleAuthUrl(c.env, `${base}/oauth/google/callback`, await makeState(c.env), c.req.query('hint')));
});

app.get('/oauth/google/callback', async (c) => {
  const { code, state, error } = c.req.query();
  if (error) return c.redirect(`/?error=${encodeURIComponent(error)}#mailboxes`);
  if (!code || !state || !(await checkState(c.env, state))) return c.text('Invalid or expired OAuth state. Start again from the Mailboxes tab.', 400);
  const base = await baseUrl(c.env, c.req.url);
  const tok = await exchangeCode(c.env, code, `${base}/oauth/google/callback`);
  if (!tok.refresh_token) return c.text('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.', 400);
  const mb = await svc.upsertMailbox(c.env, {
    email: tok.email,
    name: tok.name,
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    expires_in: tok.expires_in,
  });
  c.executionCtx.waitUntil(
    (async () => {
      await syncMailbox(c.env, mb); // sets the history cursor
      await svc.refreshSendAs(c.env, mb).catch((e) => console.error('send-as load failed', e));
      await renewWatches(c.env, true);
    })(),
  );
  return c.redirect(`/?connected=${encodeURIComponent(mb.email)}#mailboxes`);
});

// SES bounce / complaint events via SNS. The token keeps strangers out; the SNS signature proves it's AWS.
app.post('/webhooks/ses', async (c) => {
  if (!safeEqual(c.req.query('token') || '', await sesWebhookToken(c.env))) return c.text('forbidden', 403);
  const msg = await c.req.json().catch(() => null);
  if (!msg) return c.json({ error: 'Expected an SNS message' }, 400);
  const r = await handleSesWebhook(c.env, msg);
  return c.json(r.result, r.status as 200);
});

app.post('/webhooks/gmail', async (c) => {
  if (!safeEqual(c.req.query('token') || '', await webhookToken(c.env))) return c.text('forbidden', 403);
  const body = await c.req.json().catch(() => ({}));
  c.executionCtx.waitUntil(handlePush(c.env, body).catch((e) => console.error('push failed', e)));
  return c.body(null, 204); // ack quickly so Pub/Sub doesn't redeliver
});

// ---------------- MCP ----------------

app.all('/mcp', requireAuth('api'), (c) => handleMcp(c.env, c.req.raw));

// ---------------- API docs ----------------

app.get('/api-docs', requireAuth('page'), (c) => c.html(swaggerPage(appName(c.env))));
app.get('/api-docs/openapi.json', requireAuth('api'), async (c) => c.json(openApiSpec(await baseUrl(c.env, c.req.url), appName(c.env))));

// ---------------- UI ----------------

app.get('/', requireAuth('page'), async (c) => {
  await baseUrl(c.env, c.req.url);
  // Always fetch the app fresh, so a new deploy shows up on the next load.
  return c.html(appPage(appName(c.env)), 200, { 'cache-control': 'no-cache' });
});

// ---------------- REST API ----------------

const api = new Hono<App>();
api.use('*', requireAuth('api'));

const q = (c: { req: { query: () => Record<string, string> } }) => {
  const o: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') o[k] = v === 'true' ? true : v === 'false' ? false : v;
  return o;
};
const id = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid id');
  return n;
};

// Change the passcode (API and MCP key, and the sign-in). Not for a passcode set at deploy time.
api.post('/passcode', async (c) => {
  if (c.env.PASSCODE) throw new HttpError(409, 'This passcode was set at deploy time; change it there.');
  const b = await c.req.json<{ passcode?: string }>().catch(() => ({} as { passcode?: string }));
  try {
    await setPasscode(c.env, String(b.passcode || ''));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return c.json({ ok: true });
});

api.get('/config', async (c) => {
  const base = await baseUrl(c.env, c.req.url);
  return c.json({
    base_url: base,
    app_name: appName(c.env),
    purposes: Object.fromEntries(PURPOSE_KEYS.map((k) => [k, PURPOSES[k]])),
    dnc_scopes: Object.fromEntries(DNC_SCOPES.map((k) => [k, DNC_SCOPE_LABELS[k]])),
    mcp_url: `${base}/mcp`,
    // Set in the app (changeable on the MCP & API page), unless it was set at deploy time.
    passcode_in_app: !c.env.PASSCODE,
    oauth_redirect_uri: `${base}/oauth/google/callback`,
    google_configured: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    pubsub_topic: c.env.GMAIL_PUBSUB_TOPIC || null,
    gmail_push_endpoint: `${base}/webhooks/gmail?token=${await webhookToken(c.env)}`,
    ses_webhook_endpoint: `${base}/webhooks/ses?token=${await sesWebhookToken(c.env)}`,
    ses_sns: JSON.parse((await getSetting(c.env, 'ses_sns')) || 'null'),
    ses_last_event: JSON.parse((await getSetting(c.env, 'ses_last_event')) || 'null'),
  });
});
api.get('/settings', async (c) => c.json(await readSettings(c.env)));
/** New Gmail push token: the old push URL stops working until the Pub/Sub subscription is updated. */
api.post('/settings/push-token', async (c) => {
  const token = await regenerateWebhookToken(c.env);
  return c.json({ gmail_push_endpoint: `${await baseUrl(c.env, c.req.url)}/webhooks/gmail?token=${token}` });
});
api.put('/settings', async (c) => c.json(await saveSettings(c.env, await c.req.json())));
api.get('/overview', async (c) => c.json(await svc.overview(c.env)));

api.get('/mailboxes', async (c) => c.json(await svc.listMailboxes(c.env)));
api.patch('/mailboxes/:id', async (c) => c.json(await svc.updateMailbox(c.env, id(c.req.param('id')), await c.req.json())));
api.delete('/mailboxes/:id', async (c) => c.json(await svc.disconnectMailbox(c.env, id(c.req.param('id')))));
api.get('/mailboxes/:id/plan', async (c) =>
  c.json(await svc.previewPlan(c.env, id(c.req.param('id')), Number(c.req.query('count') || 0), c.req.query('start_at') || undefined)),
);
api.post('/mailboxes/ses', async (c) => c.json(await svc.createSesMailbox(c.env, await c.req.json()), 201));
api.post('/mailboxes/:id/ses-check', async (c) => c.json(await svc.recheckSes(c.env, id(c.req.param('id')))));
api.post('/mailboxes/:id/send-as', async (c) => c.json(await svc.refreshSendAs(c.env, await svc.getMailbox(c.env, id(c.req.param('id'))))));
api.post('/mailboxes/:id/sync', async (c) => {
  const mb = await svc.getMailbox(c.env, id(c.req.param('id')));
  const r = await syncMailbox(c.env, mb);
  const w = await deliverWebhooks(c.env);
  return c.json({ ...r, webhooks: w });
});

// Senders: From name / From address / Reply-To identities under a mailbox
api.get('/senders', async (c) => c.json(await senders.listSenders(c.env, q(c))));
api.post('/senders', async (c) => c.json(await senders.createSender(c.env, await c.req.json()), 201));
api.get('/senders/:id', async (c) => c.json(await senders.getSender(c.env, c.req.param('id'))));
api.patch('/senders/:id', async (c) => c.json(await senders.updateSender(c.env, c.req.param('id'), await c.req.json())));
api.delete('/senders/:id', async (c) => c.json(await senders.deleteSender(c.env, c.req.param('id'))));

// Mailbox groups: several mailboxes that send as one
api.get('/groups', async (c) => c.json(await groups.listGroups(c.env)));
api.post('/groups', async (c) => c.json(await groups.createGroup(c.env, await c.req.json()), 201));
api.get('/groups/:id', async (c) => c.json(await groups.getGroup(c.env, c.req.param('id'))));
api.patch('/groups/:id', async (c) => c.json(await groups.updateGroup(c.env, c.req.param('id'), await c.req.json())));
api.delete('/groups/:id', async (c) => c.json(await groups.deleteGroup(c.env, c.req.param('id'))));
api.get('/groups/:id/plan', async (c) => c.json(await svc.previewGroupPlan(c.env, c.req.param('id'), Number(c.req.query('count')), c.req.query('start_at'))));

// Everything that happened with one address (or contact id): emails, replies, lists, series, do-not-send
api.get('/people/:ref/activity', async (c) => c.json(await activity(c.env, c.req.param('ref'))));

// Series (drip campaigns): template emails sent one after another to everyone on the attached lists
api.get('/series', async (c) => c.json(await series.listSeries(c.env)));
api.post('/series', async (c) => c.json(await series.createSeries(c.env, await c.req.json()), 201));
api.get('/series/:id', async (c) => c.json(await series.getSeries(c.env, c.req.param('id'))));
api.patch('/series/:id', async (c) => c.json(await series.updateSeries(c.env, c.req.param('id'), await c.req.json())));
api.delete('/series/:id', async (c) => c.json(await series.deleteSeries(c.env, c.req.param('id'))));
api.post('/series/:id/steps', async (c) => c.json(await series.addStep(c.env, c.req.param('id'), await c.req.json()), 201));
api.patch('/series/:id/steps/:step', async (c) => c.json(await series.updateStep(c.env, c.req.param('id'), c.req.param('step'), await c.req.json())));
api.delete('/series/:id/steps/:step', async (c) => c.json(await series.deleteStep(c.env, c.req.param('id'), c.req.param('step'))));
api.get('/series/:id/enrollments', async (c) => c.json(await series.listEnrollments(c.env, c.req.param('id'), q(c))));
api.patch('/series/:id/enrollments/:enrollment', async (c) => c.json(await series.setEnrollment(c.env, c.req.param('id'), c.req.param('enrollment'), await c.req.json())));
api.post('/series/:id/run', async (c) => c.json(await series.runSeries(c.env, c.req.param('id'))));

api.get('/emails', async (c) => c.json(await svc.listEmails(c.env, q(c))));
api.post('/emails', async (c) => {
  const body = await c.req.json();
  const emails = Array.isArray(body) ? body : Array.isArray(body.emails) ? body.emails : [body];
  const opts = Array.isArray(body) ? {} : { auto: !!body.auto_schedule, start_at: body.start_at };
  return c.json(await svc.scheduleEmails(c.env, emails, opts), 201);
});
api.post('/emails/cancel', async (c) => c.json(await svc.cancelEmails(c.env, await c.req.json())));
api.post('/emails/send-now', async (c) => c.json(await svc.sendNow(c.env, await c.req.json(), (ids) => processDue(c.env, ids))));
api.get('/emails/:id', async (c) => c.json(await svc.getEmail(c.env, id(c.req.param('id')))));
api.patch('/emails/:id', async (c) => c.json(await svc.updateScheduledEmail(c.env, id(c.req.param('id')), await c.req.json())));
api.get('/emails/:id/conversation', async (c) => c.json(await svc.conversation(c.env, id(c.req.param('id')))));
// Answer one of our sent emails in the same thread; sends now unless send_at is given.
api.post('/emails/:id/reply', async (c) => c.json(await sendReply(c.env, id(c.req.param('id')), await c.req.json()), 201));

api.get('/replies', async (c) => c.json(await svc.listReplies(c.env, q(c))));
api.post('/replies/:id/redeliver', async (c) => {
  const rid = id(c.req.param('id'));
  await c.env.DB.prepare("UPDATE replies SET webhook_status = 'pending' WHERE id = ?").bind(rid).run();
  return c.json(await deliverWebhooks(c.env, rid));
});

api.get('/templates', async (c) => c.json(await tmpl.listTemplates(c.env)));
api.post('/templates', async (c) => c.json(await tmpl.createTemplate(c.env, await c.req.json()), 201));
// Try a template's AI personalization on one contact; sends nothing. Unsaved prompt/subject/body can be tested.
api.post('/templates/personalize', async (c) => {
  const b = (await c.req.json()) as Parameters<typeof previewPersonalization>[2] & { template_id?: string };
  return c.json(await previewPersonalization(c.env, b.template_id || null, b));
});
api.get('/templates/:tid', async (c) => c.json(await tmpl.getTemplate(c.env, c.req.param('tid'))));
api.patch('/templates/:tid', async (c) => c.json(await tmpl.updateTemplate(c.env, c.req.param('tid'), await c.req.json())));
api.delete('/templates/:tid', async (c) => c.json(await tmpl.deleteTemplate(c.env, c.req.param('tid'))));
api.post('/templates/:tid/check', async (c) => {
  const b = (await c.req.json()) as { emails?: string[] };
  return c.json(await tmpl.checkTemplateRecipients(c.env, c.req.param('tid'), b.emails || []));
});

api.get('/categories', async (c) => c.json(await cat.listCategories(c.env)));
api.post('/categories', async (c) => c.json(await cat.saveCategory(c.env, await c.req.json())));
api.delete('/categories/:name', async (c) => c.json(await cat.deleteCategory(c.env, c.req.param('name'))));
api.get('/ai', async (c) =>
  c.json({ ...(await cat.aiConfig(c.env)), personalization: { default_system_prompt: DEFAULT_SYSTEM, always_added: systemSuffix('<today>') } }),
);
api.put('/ai', async (c) => c.json(await cat.setAiSettings(c.env, await c.req.json())));
/** Try the categorizer on any text (costs one OpenRouter call). */
api.post('/ai/test', async (c) => {
  const b = (await c.req.json()) as { text?: string; subject?: string };
  if (!b.text?.trim()) throw new HttpError(400, 'text is required');
  return c.json(await cat.categorize(c.env, { reply: b.text, reply_subject: b.subject }));
});
api.post('/replies/:id/category', async (c) => {
  const b = (await c.req.json()) as { category: string | null };
  const r = await applyCategory(c.env, id(c.req.param('id')), b.category ? cat.normCategoryName(b.category) : null, 'manual');
  return c.json(svc.publicReply(r));
});
api.post('/replies/:id/categorize', async (c) => {
  const { reply, result } = await recategorize(c.env, id(c.req.param('id')));
  return c.json({ reply: svc.publicReply(reply), result });
});

// Contacts and lists
api.get('/contacts', async (c) => c.json(await contacts.listContacts(c.env, q(c))));
api.post('/contacts', async (c) => {
  const r = await contacts.saveContact(c.env, await c.req.json());
  return c.json(r, r.created ? 201 : 200);
});
api.post('/contacts/import', async (c) => {
  if (await storageFull(c.env)) throw new HttpError(409, STORAGE_FULL);
  return c.json(await contacts.importContacts(c.env, await c.req.json()));
});
api.post('/contacts/lists', async (c) => c.json(await contacts.setContactLists(c.env, await c.req.json())));
api.post('/contacts/delete', async (c) => {
  const b = (await c.req.json()) as contacts.ContactSelection;
  return c.json(await contacts.deleteContacts(c.env, b.ids || [], b.emails || [], { filter: b.filter, exclude_ids: b.exclude_ids }));
});
api.get('/contacts/fields', async (c) => c.json(await contacts.contactFields(c.env)));
// CSV of contacts: ?ids=1,2,3, or a filter (list, q, rules, match), optionally minus exclude_ids
api.get('/contacts/export', async (c) => {
  const o = q(c) as Record<string, string>;
  const ids = o.ids ? String(o.ids).split(',').map(Number).filter(Number.isInteger) : undefined;
  const exclude_ids = o.exclude_ids ? String(o.exclude_ids).split(',').map(Number).filter(Number.isInteger) : undefined;
  const { csv } = await contacts.exportContacts(c.env, ids ? { ids } : { filter: { list: o.list, q: o.q, rules: o.rules, match: o.match as 'all' | 'any' }, exclude_ids });
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"` } });
});
api.get('/contacts/:id', async (c) => c.json(await contacts.getContact(c.env, id(c.req.param('id')))));
api.patch('/contacts/:id', async (c) => c.json(await contacts.updateContact(c.env, id(c.req.param('id')), await c.req.json())));
api.get('/lists', async (c) => c.json(await contacts.listLists(c.env)));
api.post('/lists', async (c) => c.json(await contacts.createList(c.env, await c.req.json()), 201));
api.post('/lists/preview', async (c) => c.json(await contacts.previewListSend(c.env, await c.req.json())));
api.post('/lists/send', async (c) => c.json(await contacts.sendToLists(c.env, await c.req.json()), 201));
api.patch('/lists/:id', async (c) => c.json(await contacts.updateList(c.env, id(c.req.param('id')), await c.req.json())));
api.delete('/lists/:id', async (c) => c.json(await contacts.deleteList(c.env, id(c.req.param('id')))));

api.get('/campaigns', async (c) => c.json(await svc.listCampaigns(c.env)));
api.get('/campaigns/:name', async (c) => c.json(await svc.campaignStats(c.env, c.req.param('name'))));

api.get('/dnc', async (c) => c.json(await svc.dncList(c.env, q(c))));
api.post('/dnc', async (c) => {
  const b = (await c.req.json()) as { emails?: string[]; email?: string; reason?: string; scope?: string };
  return c.json(await svc.dncAdd(c.env, b.emails || (b.email ? [b.email] : []), b.reason || null, 'manual', null, (b.scope || 'all') as never));
});
api.delete('/dnc', async (c) => {
  const b = (await c.req.json()) as { emails?: string[]; email?: string };
  return c.json(await svc.dncRemove(c.env, b.emails || (b.email ? [b.email] : [])));
});

/** Run the cron work now (useful locally and for "Sync now"). */
api.post('/run', async (c) => c.json(await runCron(c.env)));

app.route('/api', api);

export async function runCron(env: Env) {
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      out[name] = { error: (err as Error).message };
      console.error(name, err);
    }
  };
  // Series first, so a step that comes due goes out in the same run.
  await step('series', () => runSeries(env));
  await step('send', () => processDue(env));
  await step('sync', () => syncAll(env));
  await step('webhooks', () => deliverWebhooks(env));
  await step('watch', () => renewWatches(env));
  return out;
}

export default {
  // App-saved settings (Settings page) override the deploy-time vars and secrets everywhere.
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, await withConfig(env), ctx);
  },
  // Replies to SES emails, delivered by Cloudflare Email Routing (catch-all on the reply domain → this Worker).
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    await handleInboundEmail(await withConfig(env), message, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(withConfig(env).then(runCron));
  },
} satisfies ExportedHandler<Env>;
