export interface Env {
  DB: D1Database;
  /** Optional: a deploy-time passcode (older installs). Normally the first admin sets it in the app (auth.ts). */
  PASSCODE?: string;
  /** Filled in by withConfig from settings (auth.ts loadAuth). */
  SESSION_SECRET?: string;
  PASSCODE_HASH?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PUBLIC_URL?: string;
  GMAIL_PUBSUB_TOPIC?: string;
  SEND_BATCH?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  APP_NAME?: string;
  /** Set by the SleekSky platform when it runs this instance (src/platform.ts); absent when self-hosted. */
  APP_ID?: string;
  /** The console's URL, for browser redirects (platform sign-in). */
  CONTROLLER_URL?: string;
  /** The way to the platform API (https://sky/...); it knows which app is calling, so no key is sent. */
  SKY?: Fetcher;
  PLATFORM_DOMAIN?: string;
  APP_SUBDOMAIN?: string;
  /** Runs the per-minute work on the platform, where there's no cron (src/scheduler.ts). */
  SCHEDULER?: DurableObjectNamespace;
  /** The original Worker env, before app-saved settings were applied (see config.ts). */
  DEPLOY_ENV?: Env;
}

export const now = () => Date.now();

const enc = new TextEncoder();

export function normEmail(e: string | null | undefined): string {
  return (e || '').trim().toLowerCase();
}

export function isEmail(e: string): boolean {
  return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(e);
}

export function randomToken(bytes = 18): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64urlBytes(a);
}

export function b64urlBytes(a: Uint8Array): string {
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlEncodeStr(str: string): string {
  return b64urlBytes(enc.encode(str));
}

export function b64urlDecodeStr(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Accepts ISO string, epoch ms/seconds, or empty (=now). */
export function parseTime(v: unknown): number {
  if (v === undefined || v === null || v === '') return now();
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseTime(Number(s));
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new HttpError(400, `Invalid time: ${s}`);
  return t;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

/** Base URL for links embedded in emails (pixel/unsubscribe) and OAuth redirect. */
export async function baseUrl(env: Env, reqUrl?: string): Promise<string> {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  if (reqUrl) {
    const origin = new URL(reqUrl).origin;
    if ((await getSetting(env, 'base_url')) !== origin) await setSetting(env, 'base_url', origin);
    return origin;
  }
  const stored = await getSetting(env, 'base_url');
  if (!stored) throw new Error('PUBLIC_URL is not set and no base URL detected yet; open the UI once or set PUBLIC_URL');
  return stored;
}

/**
 * Token in the Gmail Pub/Sub push URL. Stored on its own so changing the passcode doesn't break push.
 * The first time it's needed it is seeded with the value older versions derived from the passcode,
 * so a push subscription created before this change keeps working.
 */
export async function webhookToken(env: Env): Promise<string> {
  const stored = await getSetting(env, 'push_token');
  if (stored) return stored;
  const seeded = (await hmacHex(env.PASSCODE || env.SESSION_SECRET!, 'gmail-push')).slice(0, 32);
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('push_token', ?)").bind(seeded).run();
  return (await getSetting(env, 'push_token')) || seeded;
}

/** Token in the SES/SNS webhook URL (random, created on first use). */
export async function sesWebhookToken(env: Env): Promise<string> {
  const stored = await getSetting(env, 'ses_token');
  if (stored) return stored;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('ses_token', ?)").bind(token).run();
  return (await getSetting(env, 'ses_token')) || token;
}

/** New random push token. The Pub/Sub subscription must be updated to the new URL. */
export async function regenerateWebhookToken(env: Env): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await setSetting(env, 'push_token', token);
  return token;
}
