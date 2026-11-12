import { Env, HttpError } from './util';

/**
 * Settings that can be changed in the app after deploy. A value saved in the app (settings table,
 * key "cfg:<NAME>") overrides the Worker var/secret of the same name; clearing it falls back to the
 * deploy-time value. PASSCODE is deliberately not here: it is the key to the app and stays deploy-only.
 */
export interface ConfigField {
  key: ConfigKey;
  label: string;
  secret: boolean;
  help: string;
  validate: (v: string) => string; // returns the cleaned value or throws
}

export type ConfigKey = 'APP_NAME' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'OPENROUTER_API_KEY' | 'GMAIL_PUBSUB_TOPIC' | 'SEND_BATCH' | 'PUBLIC_URL';

const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};
const secretValue = (name: string) => (v: string) => (v.length > 1000 || /\s/.test(v) ? bad(`${name} looks wrong (no spaces, at most 1000 characters)`) : v);

export const DEFAULT_APP_NAME = 'Outbound';

export const CONFIG_FIELDS: ConfigField[] = [
  {
    key: 'APP_NAME',
    label: 'App name',
    secret: false,
    help: `Shown in the header, the browser tab and the sign-in page. Default: ${DEFAULT_APP_NAME}.`,
    validate: (v) => (v.length <= 40 && !/[<>]/.test(v) ? v : bad('App name must be at most 40 characters, without < or >')),
  },
  {
    key: 'GOOGLE_CLIENT_ID',
    label: 'Google client ID',
    secret: false,
    help: 'From Google Cloud → Google Auth Platform → Clients (Web application).',
    validate: (v) => (/^[\w.-]+\.apps\.googleusercontent\.com$/.test(v) ? v : bad('Google client ID should end with .apps.googleusercontent.com')),
  },
  { key: 'GOOGLE_CLIENT_SECRET', label: 'Google client secret', secret: true, help: 'Shown when you create the OAuth client.', validate: secretValue('Google client secret') },
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, help: 'Enables AI reply categories. From openrouter.ai → Keys.', validate: secretValue('OpenRouter API key') },
  {
    key: 'GMAIL_PUBSUB_TOPIC',
    label: 'Gmail Pub/Sub topic',
    secret: false,
    help: 'projects/<project-id>/topics/<topic>. Empty = check for replies every minute instead.',
    validate: (v) => (/^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/.test(v) ? v : bad('Topic must look like projects/<project-id>/topics/<topic>')),
  },
  {
    key: 'SEND_BATCH',
    label: 'Emails per minute (all mailboxes)',
    secret: false,
    help: 'Most emails sent per cron run, across all mailboxes. Per-mailbox limits still apply.',
    validate: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 100 ? String(Number(v)) : bad('Emails per minute must be a whole number from 1 to 100')),
  },
  {
    key: 'PUBLIC_URL',
    label: 'Public URL',
    secret: false,
    help: 'Used for the tracking pixel, unsubscribe links and Google sign-in. Usually detected automatically.',
    validate: (v) => {
      const u = v.replace(/\/+$/, '');
      return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u) ? u : bad('Public URL must look like https://host (no path)');
    },
  },
];

const PREFIX = 'cfg:';
const CACHE_MS = 15_000;
let cache: { at: number; values: Record<string, string> } | null = null;

async function loadOverrides(env: Env): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.values;
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'cfg:%'").all<{ key: string; value: string }>();
  const values = Object.fromEntries(rows.results.filter((r) => r.value).map((r) => [r.key.slice(PREFIX.length), r.value]));
  cache = { at: Date.now(), values };
  return values;
}

/** The Worker env with app-saved settings applied on top. Use at every entry point. */
export async function withConfig(env: Env): Promise<Env> {
  try {
    const o = await loadOverrides(env);
    return { ...env, ...o, DEPLOY_ENV: env } as Env;
  } catch (err) {
    // Settings table missing (migrations not applied yet): run on deploy-time values.
    console.error('settings load failed', (err as Error).message);
    return { ...env, DEPLOY_ENV: env };
  }
}

/** What the Settings page shows. Secret values are never returned, only whether they're set. */
export async function getSettings(env: Env, deployEnv: Env) {
  cache = null;
  const o = await loadOverrides(env);
  return CONFIG_FIELDS.map((f) => {
    const app = o[f.key];
    const deploy = (deployEnv as unknown as Record<string, string | undefined>)[f.key] || '';
    return {
      key: f.key,
      label: f.label,
      help: f.help,
      secret: f.secret,
      source: app ? 'app' : deploy ? 'deploy' : 'none',
      is_set: !!(app || deploy),
      value: f.secret ? null : app || deploy || '',
      deploy_value: f.secret ? (deploy ? '(set)' : '') : deploy,
    };
  });
}

/**
 * Save settings. A string sets the app value; "" or null clears it (back to the deploy-time value).
 * Returns which keys changed so callers can react (e.g. re-watch Gmail when the topic changes).
 */
export async function updateSettings(env: Env, patch: Record<string, unknown>): Promise<ConfigKey[]> {
  const known = new Map(CONFIG_FIELDS.map((f) => [f.key, f]));
  const unknown = Object.keys(patch).filter((k) => !known.has(k as ConfigKey));
  if (unknown.length) throw new HttpError(400, `Unknown or read-only setting: ${unknown.join(', ')}${unknown.includes('PASSCODE') ? ' (PASSCODE can only be set at deploy time)' : ''}`);
  const before = await loadOverrides(env);
  const stmts: D1PreparedStatement[] = [];
  const changed: ConfigKey[] = [];
  for (const [k, raw] of Object.entries(patch)) {
    const f = known.get(k as ConfigKey)!;
    const v = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!v) {
      stmts.push(env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(PREFIX + k));
      if (before[k]) changed.push(f.key);
      continue;
    }
    const clean = f.validate(v);
    stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(PREFIX + k, clean));
    if (before[k] !== clean) changed.push(f.key);
  }
  if (stmts.length) await env.DB.batch(stmts);
  cache = null;
  return changed;
}

/** For tests. */
export function _resetConfigCache() {
  cache = null;
}
