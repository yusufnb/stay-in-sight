import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { baseUrl, Env, hmacHex, now, safeEqual } from './util';

export const SESSION_COOKIE = 'ob_session';
const SESSION_TTL_MS = 30 * 24 * 3600_000;

export async function makeSession(env: Env): Promise<string> {
  const exp = now() + SESSION_TTL_MS;
  return `${exp}.${await hmacHex(env.PASSCODE, `session:${exp}`)}`;
}

async function validSession(env: Env, v: string | undefined): Promise<boolean> {
  if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < now()) return false;
  return safeEqual(sig, await hmacHex(env.PASSCODE, `session:${exp}`));
}

export function checkPasscode(env: Env, given: string | null | undefined): boolean {
  if (!env.PASSCODE) return false;
  return !!given && safeEqual(given, env.PASSCODE);
}

/** Accepts: session cookie (UI), `Authorization: Bearer <passcode>`, `x-passcode` header, or `?key=<passcode>`. */
export async function isAuthed(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const env = c.env;
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ') && checkPasscode(env, auth.slice(7).trim())) return true;
  if (checkPasscode(env, c.req.header('x-passcode'))) return true;
  if (checkPasscode(env, c.req.query('key'))) return true;
  return validSession(env, getCookie(c, SESSION_COOKIE));
}

export function requireAuth(kind: 'api' | 'page') {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (!c.env.PASSCODE) return c.text('PASSCODE secret is not configured. Run: npx wrangler secret put PASSCODE', 500);
    if (await isAuthed(c)) {
      // Remember the public origin so cron-sent emails get correct pixel/unsubscribe links.
      if (!c.env.PUBLIC_URL) await baseUrl(c.env, c.req.url);
      return next();
    }
    if (kind === 'page') {
      const path = new URL(c.req.url).pathname;
      return c.redirect(path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`);
    }
    return c.json({ error: 'Unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="outbound"' });
  };
}
