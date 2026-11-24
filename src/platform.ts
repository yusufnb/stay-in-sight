// Running as an app on the SleekSky platform (cf-controller: docs/app-auth.md, docs/site/tenant-api.md,
// docs/site/runtime.md, docs/site/manifest.md). The controller deploys one instance per customer and sets WORKSPACE_ID,
// CONTROLLER_URL (the console, for browser redirects) and the SKY service binding; without WORKSPACE_ID and SKY
// nothing here applies and the app behaves as a self-hosted install (a cron every minute). Either way, the first admin
// sets the passcode and every setting in the app after deploy.
//
// Everything this app asks of the platform goes over SKY (https://sky/...): the binding tells the platform which app
// is calling, so no key or token is sent.
//
//   GET  /_health                  the controller checks it after every deploy
//   GET  /auth/platform            platform sign-in (manifest "signin_path"): off to the console's /auth
//   GET  /auth/platform/callback   back with a one-time code; account owners and staff get a session here (then the
//                                  setup page, where the first admin chooses the passcode, if there isn't one yet)
//   POST /_platform/tick           manifest "schedules", every 15 minutes: makes sure the Scheduler's 1-minute alarm
//                                  is running
//
// The platform's dispatch Worker refuses outside requests to /_platform/*, so those routes need no token check.
// Platform instances have no cron: the Scheduler Durable Object (src/scheduler.ts) runs the same work every minute.
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isSetUp, makeSession, SESSION_COOKIE } from './auth';
import { loginPage, safeNext } from './ui';
import { DEFAULT_APP_NAME } from './config';
import { Env, safeEqual } from './util';

export const onPlatform = (env: Env) => !!(env.WORKSPACE_ID && env.SKY);

/** A call to the platform API over SKY. Throws with the platform's `{ error }` message when it fails. */
export async function skyFetch<T = Record<string, unknown>>(env: Env, path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await env.SKY!.fetch(`https://sky${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data?.error || `SleekSky answered ${r.status}`);
  return data;
}

export type PlatformInfo = {
  app: { id: string; name: string; subdomain: string; product: string | null; account: string | null };
  services: string[];
  allowance: { total: number; spent: number; left: number } | null;
  storage: 'ok' | 'warn' | 'over';
};
let info: { at: number; ttl: number; data: PlatformInfo | null } | null = null;
let asking: Promise<void> | null = null;

/**
 * What the platform says about this app (GET /api/tenant/init), cached per isolate for the TTL it gives (5 minutes).
 * If the platform can't be reached, the last copy is kept (or none) and it's asked again after a minute.
 */
export async function platformInfo(env: Env): Promise<PlatformInfo | null> {
  if (!onPlatform(env)) return null;
  if (!info || Date.now() - info.at > info.ttl * 1000) {
    asking ??= skyFetch<PlatformInfo & { ttl?: number }>(env, '/api/tenant/init')
      .then((d) => { info = { at: Date.now(), ttl: Number(d.ttl) || 300, data: d }; })
      .catch((e) => {
        console.error('platform init', e);
        info = info ? { ...info, at: Date.now() - info.ttl * 1000 + 60_000 } : { at: Date.now(), ttl: 60, data: null };
      })
      .finally(() => { asking = null; });
    await asking;
  }
  return info?.data ?? null;
}

/** Wake the Scheduler: it sets its 1-minute alarm if it isn't already running. */
export const ensureScheduler = (env: Env) => env.SCHEDULER!.get(env.SCHEDULER!.idFromName('scheduler')).fetch('https://scheduler/ensure');

export const STORAGE_FULL = 'This app has used all of its storage. Delete old contacts or emails, or upgrade in the SleekSky console, to import more.';
/** Over the plan's storage allowance, as the platform says in init. */
export const storageFull = async (env: Env) => (await platformInfo(env))?.storage === 'over';

export const platformRoutes = new Hono<{ Bindings: Env }>();

platformRoutes.get('/_health', async (c) => {
  const ok = await c.env.DB.prepare('SELECT 1 AS one').first().then(() => true, () => false);
  return c.json({ ok }, ok ? 200 : 503);
});

// Platform sign-in: random state (and where to go after) in a short-lived cookie, then the console's /auth.
const STATE_COOKIE = 'sis_pauth';
const STATE_PATH = '/auth/platform';
const appName = (env: Env) => env.APP_NAME?.trim() || DEFAULT_APP_NAME;

platformRoutes.get('/auth/platform', (c) => {
  if (!onPlatform(c.env) || !c.env.CONTROLLER_URL) return c.redirect('/login');
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const next = safeNext(c.req.query('next'));
  setCookie(c, STATE_COOKIE, `${state}.${next}`, { path: STATE_PATH, httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 });
  const to = new URL('/auth', c.env.CONTROLLER_URL);
  to.search = new URLSearchParams({ app: c.env.WORKSPACE_ID!, redirect: `${new URL(c.req.url).origin}${STATE_PATH}/callback`, state }).toString();
  c.header('cache-control', 'no-store');
  return c.redirect(to.toString());
});

platformRoutes.get('/auth/platform/callback', async (c) => {
  if (!onPlatform(c.env)) return c.redirect('/login');
  const pc = getCookie(c, STATE_COOKIE) || '', dot = pc.indexOf('.');
  const state = dot > 0 ? pc.slice(0, dot) : '', next = dot > 0 ? safeNext(pc.slice(dot + 1)) : '/';
  deleteCookie(c, STATE_COOKIE, { path: STATE_PATH });
  const fail = (error: string, status: 400 | 403 | 502) => c.html(loginPage(error, appName(c.env), next, true), status);
  const code = c.req.query('code') || '';
  if (!state || !code || !safeEqual(state, c.req.query('state') || '')) return fail("That sign-in didn't start here, or took too long. Please try again.", 400);
  let who: { email?: string; name?: string | null; owner?: boolean; staff?: boolean };
  try {
    who = await skyFetch(c.env, '/auth/token', 'POST', { code, redirect: `${new URL(c.req.url).origin}${STATE_PATH}/callback` });
  } catch (e) {
    console.error('platform sign-in', e);
    return fail("Couldn't finish signing in with SleekSky. Please try again.", 502);
  }
  // This app has one passcode and no user accounts: only the account's owners and staff come in.
  if (!who.owner && !who.staff) {
    if (who.email) c.executionCtx.waitUntil(skyFetch(c.env, '/api/tenant/signins/remove', 'POST', { email: who.email }).catch((e) => console.error('signins/remove', e)));
    return fail(`${who.email || 'That account'} can't use this app. Only the account's owners and staff can sign in.`, 403);
  }
  setCookie(c, SESSION_COOKIE, await makeSession(c.env), { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 30 * 24 * 3600 });
  c.executionCtx.waitUntil(ensureScheduler(c.env).then(() => undefined, (e) => console.error('scheduler', e)));
  // First time: the admin chooses the passcode (for the API and MCP) before anything else.
  if (!isSetUp(c.env)) return c.redirect('/setup');
  return c.redirect(next);
});

platformRoutes.post('/_platform/tick', async (c) => {
  const scheduler = await (await ensureScheduler(c.env)).json();
  return c.json({ ok: true, scheduler });
});
