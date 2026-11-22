import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { baseUrl, Env, getSetting, hmacHex, now, safeEqual, setSetting } from './util';

export const SESSION_COOKIE = 'ob_session';
const SESSION_TTL_MS = 30 * 24 * 3600_000;

/**
 * The passcode (UI sign-in, API and MCP Bearer token) is set in the app by its first admin, after deploy, and kept
 * as a salted PBKDF2 hash in settings ("passcode_hash"). Sessions, OAuth state and push tokens are signed with a
 * separate random secret the app makes for itself ("session_secret"), so changing the passcode signs nobody out.
 * A deploy-time PASSCODE secret (older self-hosted installs) still works and is then used for both.
 */
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const ITERATIONS = 100_000;
async function pbkdf2(passcode: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export async function hashPasscode(passcode: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${await pbkdf2(passcode, salt, ITERATIONS)}`;
}
async function matchesHash(passcode: string, stored: string) {
  const [kind, it, salt, hash] = stored.split('$');
  if (kind !== 'pbkdf2' || !it || !salt || !hash) return false;
  return safeEqual(await pbkdf2(passcode, Uint8Array.from(atob(salt), (ch) => ch.charCodeAt(0)), Number(it)), hash);
}

export const PASSCODE_MIN = 12;
/** Set (or change) the passcode. */
export async function setPasscode(env: Env, passcode: string) {
  if (passcode.length < PASSCODE_MIN) throw new Error(`Use at least ${PASSCODE_MIN} characters.`);
  if (passcode.length > 200) throw new Error('That passcode is too long.');
  await setSetting(env, 'passcode_hash', await hashPasscode(passcode));
}

/** SESSION_SECRET and PASSCODE_HASH for the env (withConfig calls this on every request and run). */
export async function loadAuth(env: Env): Promise<Pick<Env, 'SESSION_SECRET' | 'PASSCODE_HASH'>> {
  let secret = env.PASSCODE || (await getSetting(env, 'session_secret'));
  if (!secret) {
    secret = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('');
    // Two first requests at once: only the first secret is kept, and both read it back.
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?) ON CONFLICT(key) DO NOTHING").bind(secret).run();
    secret = (await getSetting(env, 'session_secret')) || secret;
  }
  return { SESSION_SECRET: secret, PASSCODE_HASH: (await getSetting(env, 'passcode_hash')) || undefined };
}

/** The app has a passcode (set by its first admin, or at deploy time). */
export const isSetUp = (env: Env) => !!(env.PASSCODE || env.PASSCODE_HASH);

export async function makeSession(env: Env): Promise<string> {
  const exp = now() + SESSION_TTL_MS;
  return `${exp}.${await hmacHex(env.SESSION_SECRET!, `session:${exp}`)}`;
}

async function validSession(env: Env, v: string | undefined): Promise<boolean> {
  if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < now()) return false;
  return safeEqual(sig, await hmacHex(env.SESSION_SECRET!, `session:${exp}`));
}

export async function checkPasscode(env: Env, given: string | null | undefined): Promise<boolean> {
  if (!given) return false;
  if (env.PASSCODE) return safeEqual(given, env.PASSCODE);
  return env.PASSCODE_HASH ? matchesHash(given, env.PASSCODE_HASH) : false;
}

/** Accepts: session cookie (UI), `Authorization: Bearer <passcode>`, `x-passcode` header, or `?key=<passcode>`. */
export async function isAuthed(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const env = c.env;
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ') && (await checkPasscode(env, auth.slice(7).trim()))) return true;
  if (await checkPasscode(env, c.req.header('x-passcode'))) return true;
  if (await checkPasscode(env, c.req.query('key'))) return true;
  return validSession(env, getCookie(c, SESSION_COOKIE));
}

export function requireAuth(kind: 'api' | 'page') {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (await isAuthed(c)) {
      // Remember the public origin so cron-sent emails get correct pixel/unsubscribe links.
      if (!c.env.PUBLIC_URL) await baseUrl(c.env, c.req.url);
      return next();
    }
    // Not set up yet: the first admin chooses the passcode (and then everything else) in the app.
    if (!isSetUp(c.env)) return kind === 'page' ? c.redirect('/setup') : c.json({ error: 'This app is not set up yet. Open it in a browser to choose a passcode.' }, 401);
    if (kind === 'page') {
      const path = new URL(c.req.url).pathname;
      return c.redirect(path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`);
    }
    return c.json({ error: 'Unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="outbound"' });
  };
}
