// Running as an app on the SleekSite platform (cf-controller, docs/app-spec.md). The controller deploys one instance
// per customer and sets WORKSPACE_ID, CONTROLLER_URL and CONTROLLER_KEY; without them nothing here applies and the
// app behaves as a self-hosted install (a cron every minute). Either way, the first admin sets the passcode and
// every setting in the app after deploy.
//
//   GET  /_health            the controller checks it after every deploy
//   GET  /_admin/auth/sso    "Open" from the SleekSite console: a 60-second token → a session here (then the setup
//                            page, where the first admin chooses the passcode, if there isn't one yet)
//   PUT  /_platform/owners   accepted (this app has one passcode, no user accounts)
//   POST /_platform/tick     every 15 minutes: makes sure the Scheduler's 1-minute alarm is running
//   PUT  /_platform/quota    database storage against the plan's allowance; "over" pauses contact imports
//
// Platform instances have no cron: the Scheduler Durable Object (src/scheduler.ts) runs the same work every minute.
// Tokens are HS256 JWTs signed with CONTROLLER_KEY (this instance's own key), valid 60 seconds, each used once.
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { isSetUp, makeSession, SESSION_COOKIE } from './auth';
import { Env, getSetting, setSetting } from './util';

export const onPlatform = (env: Env) => !!(env.WORKSPACE_ID && env.CONTROLLER_KEY);

const enc = new TextEncoder();
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
const hmacKey = (secret: string) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

type Claims = { iss: string; typ: string; aud: string; sub?: string; iat: number; exp: number; jti: string };

async function verifyJwt(token: string, secret: string): Promise<Claims | null> {
  const [head, body, sig] = String(token || '').split('.');
  if (!head || !body || !sig) return null;
  try {
    if (JSON.parse(new TextDecoder().decode(fromB64u(head))).alg !== 'HS256') return null;
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64u(sig), enc.encode(`${head}.${body}`)))) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    return typeof c.exp === 'number' && c.exp * 1000 + 30_000 > Date.now() ? (c as Claims) : null;
  } catch {
    return null;
  }
}

/** A controller token for this instance: signature, issuer, type, audience, a short lifetime, and never used before. */
async function controllerToken(env: Env, token: string, typ: 'sso' | 'api'): Promise<Claims | null> {
  if (!onPlatform(env)) return null;
  const c = await verifyJwt(token, env.CONTROLLER_KEY!);
  if (!c || c.iss !== 'sleeksite-controller' || c.typ !== typ || c.aud !== env.WORKSPACE_ID || !c.jti || c.exp - c.iat > 300) return null;
  await env.DB.prepare('DELETE FROM platform_jti WHERE exp < ?').bind(Math.floor(Date.now() / 1000) - 60).run();
  const fresh = await env.DB.prepare('INSERT INTO platform_jti (jti, exp) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING jti').bind(c.jti, c.exp).first();
  return fresh ? c : null;
}

/** Wake the Scheduler: it sets its 1-minute alarm if it isn't already running. */
export const ensureScheduler = (env: Env) => env.SCHEDULER!.get(env.SCHEDULER!.idFromName('scheduler')).fetch('https://scheduler/ensure');

export const STORAGE_FULL = 'This app has used all of its storage. Delete old contacts or emails, or upgrade in the SleekSite console, to import more.';
/** Over the plan's storage allowance (the controller measures it daily and says so with PUT /_platform/quota). */
export const storageFull = async (env: Env) => onPlatform(env) && (await getSetting(env, 'platform_storage')) === 'over';

export const platformRoutes = new Hono<{ Bindings: Env }>();

platformRoutes.get('/_health', async (c) => {
  const ok = await c.env.DB.prepare('SELECT 1 AS one').first().then(() => true, () => false);
  return c.json({ ok }, ok ? 200 : 503);
});

platformRoutes.get('/_admin/auth/sso', async (c) => {
  const claims = await controllerToken(c.env, c.req.query('token') || '', 'sso');
  if (!claims) return c.text('That sign-in link has expired. Open the app again from the SleekSite console.', 401);
  setCookie(c, SESSION_COOKIE, await makeSession(c.env), { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 30 * 24 * 3600 });
  c.executionCtx.waitUntil(ensureScheduler(c.env).catch((e) => console.error('scheduler', e)));
  // First time: the admin chooses the passcode (for the API and MCP) before anything else.
  if (!isSetUp(c.env)) return c.redirect('/setup');
  const next = c.req.query('next') || '/';
  return c.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
});

platformRoutes.use('/_platform/*', async (c, next) => {
  const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await controllerToken(c.env, token, 'api'))) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});
platformRoutes.put('/_platform/owners', (c) => c.json({ ok: true }));
platformRoutes.post('/_platform/tick', async (c) => {
  const scheduler = await (await ensureScheduler(c.env)).json();
  return c.json({ ok: true, scheduler });
});
platformRoutes.put('/_platform/quota', async (c) => {
  const b = await c.req.json<{ storage?: string }>().catch(() => ({} as { storage?: string }));
  const state = b.storage === 'over' || b.storage === 'warn' ? b.storage : 'ok';
  await setSetting(c.env, 'platform_storage', state);
  return c.json({ ok: true, storage: state });
});
