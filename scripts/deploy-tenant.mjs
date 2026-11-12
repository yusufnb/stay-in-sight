#!/usr/bin/env node
/**
 * Deploy one tenant of cms-outbound from tenants/<tenant>.env with a single command:
 *
 *   npm run deploy:tenant -- <tenant> [--dry-run]
 *
 * Steps: find or create the tenant's D1 database → write a Wrangler config for it →
 * apply migrations → deploy the Worker → upload secrets → print the URLs you need
 * for Google OAuth and Gmail Pub/Sub.
 *
 * wrangler.toml stays the base (compatibility date, cron, bindings); the tenant file overrides
 * the Worker name, database and vars, and supplies secrets. Blank secrets are left unchanged.
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TENANTS = join(ROOT, 'tenants');
const BUILD = join(TENANTS, '.build');

const VAR_KEYS = ['PUBLIC_URL', 'GMAIL_PUBSUB_TOPIC', 'SEND_BATCH', 'OPENROUTER_MODEL'];
const SECRET_KEYS = ['PASSCODE', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OPENROUTER_API_KEY'];
const META_KEYS = ['WORKER_NAME', 'D1_DATABASE'];
const ALL_KEYS = new Set([...META_KEYS, ...VAR_KEYS, ...SECRET_KEYS]);

// ---------- helpers ----------

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (n, s) => console.log(`\n${bold(`${n}.`)} ${bold(s)}`);
const fail = (msg) => {
  console.error(`\n${red('✘')} ${msg}`);
  process.exit(1);
};

function usage() {
  console.log(`Usage: npm run deploy:tenant -- <tenant> [--dry-run]

  <tenant>     reads tenants/<tenant>.env (copy tenants/example.env to start)
  --dry-run    resolve everything and build the Worker, but change nothing`);
  process.exit(1);
}

/** Minimal .env parser: KEY=VALUE, # comments, optional single/double quotes. */
function parseEnvFile(path) {
  const out = {};
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const m = t.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) fail(`${relative(ROOT, path)}:${i + 1}: expected KEY=VALUE`);
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      out[m[1]] = v;
    });
  return out;
}

// Cloudflare sometimes rejects the first call after wrangler's OAuth token has expired ("Authentication
// error [code: 10000]") and accepts the same call a moment later, once the token is refreshed. The
// request was rejected outright, so trying again is safe for any command.
const AUTH_ERROR = /Authentication error \[code: 10000\]/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run wrangler; returns { ok, out }. Output is echoed unless quiet. */
function wrangler(args, { input, quiet = false, allowFail = false } = {}) {
  const run = () =>
    spawnSync('npx', ['wrangler', ...args], {
      cwd: ROOT,
      input,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' }, // non-interactive: no confirmation prompts
      stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'],
    });
  let res = run();
  for (let attempt = 1; res.status !== 0 && attempt <= 2 && AUTH_ERROR.test(`${res.stdout || ''}${res.stderr || ''}`); attempt++) {
    console.log(dim(`   Cloudflare rejected the login token (it may have just been refreshed); trying again (${attempt}/2)…`));
    sleep(2000 * attempt);
    res = run();
  }
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (!quiet) process.stdout.write(out.split('\n').map((l) => (l ? `   ${l}` : l)).join('\n'));
  if (res.status !== 0 && !allowFail) fail(`wrangler ${args[0]} ${args[1] || ''} failed${quiet ? `:\n${out}` : ''}`);
  return { ok: res.status === 0, out };
}

function parseJsonOut(out) {
  const start = out.search(/[[{]/);
  try {
    return JSON.parse(out.slice(start));
  } catch {
    fail(`Couldn't read wrangler's JSON output:\n${out}`);
  }
}

const mask = (v) => (v ? `${'•'.repeat(Math.min(8, v.length))} (${v.length} chars)` : dim('(unchanged)'));

// ---------- main ----------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tenant = args.find((a) => !a.startsWith('--'));
if (!tenant) usage();
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(tenant)) fail('Tenant names use lowercase letters, numbers and dashes.');

const envPath = join(TENANTS, `${tenant}.env`);
if (!existsSync(envPath)) fail(`No ${relative(ROOT, envPath)}. Create it with:\n\n   cp tenants/example.env ${relative(ROOT, envPath)}`);
const env = parseEnvFile(envPath);
const unknown = Object.keys(env).filter((k) => !ALL_KEYS.has(k));
if (unknown.length) fail(`Unknown keys in ${relative(ROOT, envPath)}: ${unknown.join(', ')}\n   Allowed: ${[...ALL_KEYS].join(', ')}`);

const workerName = env.WORKER_NAME || `cms-outbound-${tenant}`;
const dbName = env.D1_DATABASE || workerName;
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) fail(`WORKER_NAME "${workerName}" must be lowercase letters, numbers and dashes.`);
if (env.PASSCODE && env.PASSCODE.length < 12) fail('PASSCODE must be at least 12 characters. Generate one with: openssl rand -base64 24');
if (env.PUBLIC_URL && !/^https:\/\/[^/]+$/.test(env.PUBLIC_URL.replace(/\/+$/, ''))) fail('PUBLIC_URL must look like https://host (no path).');
if (env.GMAIL_PUBSUB_TOPIC && !/^projects\/[^/]+\/topics\/[^/]+$/.test(env.GMAIL_PUBSUB_TOPIC)) {
  fail('GMAIL_PUBSUB_TOPIC must look like projects/<project-id>/topics/<topic>.');
}

console.log(`${bold('Deploying tenant')} ${green(tenant)}${dryRun ? dim('  (dry run: nothing will change)') : ''}`);
console.log(`   Worker:   ${workerName}\n   Database: ${dbName}`);

// 1. Database
step(1, 'D1 database');
const dbs = parseJsonOut(wrangler(['d1', 'list', '--json'], { quiet: true }).out);
let db = dbs.find((d) => d.name === dbName);
const firstDeploy = !db;
if (db) console.log(`   Found ${dbName} (${db.uuid})`);
else if (dryRun) console.log(`   Would create ${dbName}`);
else {
  console.log(`   Creating ${dbName}…`);
  wrangler(['d1', 'create', dbName], { quiet: true });
  db = parseJsonOut(wrangler(['d1', 'list', '--json'], { quiet: true }).out).find((d) => d.name === dbName);
  if (!db) fail(`Created ${dbName} but couldn't find it in "wrangler d1 list".`);
  console.log(`   ${green('Created')} ${dbName} (${db.uuid})`);
}

// 2. Config: wrangler.toml as the base, tenant values on top
step(2, 'Wrangler config');
const base = parseToml(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8'));
const baseDb = (base.d1_databases || []).find((d) => d.binding === 'DB');
if (!baseDb) fail('wrangler.toml has no D1 binding named DB.');
const vars = { ...(base.vars || {}) };
for (const k of VAR_KEYS) if (env[k] !== undefined) vars[k] = env[k];
// The base PUBLIC_URL belongs to the default deployment; a tenant without one auto-detects its own.
if (env.PUBLIC_URL === undefined) vars.PUBLIC_URL = '';
const config = {
  ...base,
  name: workerName,
  main: relative(BUILD, join(ROOT, base.main)),
  d1_databases: [{ ...baseDb, database_name: dbName, database_id: db?.uuid || '00000000-0000-0000-0000-000000000000', migrations_dir: relative(BUILD, join(ROOT, baseDb.migrations_dir || 'migrations')) }],
  vars,
};
mkdirSync(BUILD, { recursive: true });
const cfgPath = join(BUILD, `${tenant}.wrangler.json`);
writeFileSync(cfgPath, JSON.stringify(config, null, 2));
console.log(`   Wrote ${relative(ROOT, cfgPath)}`);
for (const k of VAR_KEYS) console.log(`   ${k.padEnd(20)} ${vars[k] === '' ? dim('(empty)') : vars[k]}`);

const secrets = Object.fromEntries(SECRET_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
for (const k of SECRET_KEYS) console.log(`   ${k.padEnd(20)} ${mask(env[k])}`);

if (dryRun) {
  step(3, 'Build check (wrangler deploy --dry-run)');
  wrangler(['deploy', '--dry-run', '--outdir', join(BUILD, `${tenant}-dist`), '-c', cfgPath]);
  console.log(`\n${green('✔')} Dry run finished. Run without --dry-run to deploy.`);
  process.exit(0);
}

// 3. Migrations
step(3, 'Database migrations');
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '-c', cfgPath]);

// 4. Deploy
step(4, 'Deploy Worker');
const deployed = wrangler(['deploy', '-c', cfgPath]);
const workersDevUrl = deployed.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];

// 5. Secrets
step(5, 'Secrets');
if (Object.keys(secrets).length) {
  wrangler(['secret', 'bulk', '-c', cfgPath], { input: JSON.stringify(secrets), quiet: true });
  console.log(`   ${green('Set')} ${Object.keys(secrets).join(', ')}`);
} else console.log('   None in the tenant file; leaving existing secrets as they are.');
const existing = parseJsonOut(wrangler(['secret', 'list', '--format', 'json', '-c', cfgPath], { quiet: true }).out).map((s) => s.name);
if (!existing.includes('PASSCODE')) fail(`PASSCODE isn't set on ${workerName}. Add PASSCODE=… to ${relative(ROOT, envPath)} and run again.`);
// Google can come from a Worker secret or from the app's Settings page (stored in D1 as cfg:<KEY>).
/** Settings saved in the app (D1): which cfg:<KEY> overrides are set, and the Gmail push token if one exists. */
function appSettings() {
  const sql = "SELECT key, value FROM settings WHERE (key LIKE 'cfg:%' AND value != '') OR key = 'push_token'";
  const { ok, out } = wrangler(['d1', 'execute', 'DB', '--remote', '--json', '-c', cfgPath, '--command', sql], { quiet: true, allowFail: true });
  const rows = (() => {
    if (!ok) return [];
    try {
      return JSON.parse(out.slice(out.indexOf('[')))?.[0]?.results || [];
    } catch {
      return [];
    }
  })();
  return {
    keys: new Set(rows.filter((r) => String(r.key).startsWith('cfg:')).map((r) => String(r.key).slice(4))),
    pushToken: rows.find((r) => r.key === 'push_token')?.value || null,
  };
}
const app = appSettings();
const appSet = app.keys;
const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((k) => !existing.includes(k) && !appSet.has(k));

// 6. On a brand-new tenant, pin the public URL if it wasn't given (pixel, unsubscribe links and OAuth need it).
//    Later deploys leave it to the Settings page or the app's auto-detection, so there's no second deploy each time.
let publicUrl = (vars.PUBLIC_URL || '').replace(/\/+$/, '');
if (!publicUrl && workersDevUrl && firstDeploy) {
  step(6, 'Public URL');
  publicUrl = workersDevUrl;
  config.vars.PUBLIC_URL = publicUrl;
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  wrangler(['deploy', '-c', cfgPath], { quiet: true });
  console.log(`   Set PUBLIC_URL=${publicUrl} and redeployed.`);
  console.log(dim(`   Add PUBLIC_URL=${publicUrl} to ${relative(ROOT, envPath)}, or set it on the Settings page, to keep it on later deploys.`));
}
if (!publicUrl) publicUrl = workersDevUrl || '';

// Summary
// The push token lives in the app's database. Before the app has created one, it will seed it from the passcode.
const token = app.pushToken || (env.PASSCODE ? createHmac('sha256', env.PASSCODE).update('gmail-push').digest('hex').slice(0, 32) : null);
console.log(`\n${green('✔')} ${bold(`Tenant ${tenant} deployed`)}`);
console.log(`   App:                    ${publicUrl || workersDevUrl || '(see wrangler output above)'}`);
if (publicUrl) {
  console.log(`   Google redirect URI:    ${publicUrl}/oauth/google/callback`);
  console.log(`   MCP:                    ${publicUrl}/mcp`);
  console.log(`   Pub/Sub push endpoint:  ${token ? `${publicUrl}/webhooks/gmail?token=${token}` : dim('shown on the Settings page')}`);
}
if (missing.length) {
  console.log(`\n   ${bold('Next:')} Google sign-in isn't set up yet (${missing.join(', ')}).`);
  console.log(`   Paste them on the Settings page${publicUrl ? `: ${publicUrl}/#config` : ''}`);
  console.log(dim(`   (or add them to ${relative(ROOT, envPath)} and deploy again).`));
}
