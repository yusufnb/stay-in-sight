import APP_HTML from './app.html';
import { DEFAULT_APP_NAME } from './config';
import { escapeHtml } from './util';

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${title}</title>
<script>/* Apply the saved color scheme before first paint: light, dark, or system (default). */(function(){var p;try{p=localStorage.getItem('theme')}catch(e){}var d=p==='dark'||(p!=='light'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')})()</script>
<style>
  :root{--bg:#f7f7f8;--surface:#fff;--line:#e7e7ea;--line-strong:#d4d4d8;--text:#18181b;--muted:#71717a;--accent:#4f46e5;--accent-hover:#4338ca;--accent-fg:#fff;--accent-soft:#eef2ff;--red:#b91c1c;--red-bg:#fef2f2;--green:#15803d;--green-bg:#ecfdf3}
  :root[data-theme=dark]{color-scheme:dark;--bg:#0d0d10;--surface:#151519;--line:#27272d;--line-strong:#3a3a42;--text:#f4f4f5;--muted:#8d8d97;--accent:#818cf8;--accent-hover:#a5b4fc;--accent-fg:#0d0d10;--accent-soft:#1f1d4a;--red:#fca5a5;--red-bg:#3b1414;--green:#86efac;--green-bg:#0b2a1b}
  *{box-sizing:border-box}
  body{font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);display:grid;place-items:center;min-height:100vh;margin:0;padding:20px;-webkit-font-smoothing:antialiased}
  .wrap{width:min(380px,100%)}
  .brand{display:flex;align-items:center;gap:10px;justify-content:center;font-weight:650;font-size:16px;margin-bottom:20px}
  .mark{width:30px;height:30px;border-radius:8px;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(16,24,40,.06),0 12px 32px rgba(16,24,40,.06)}
  h1{font-size:18px;margin:0 0 6px;letter-spacing:-.01em} p{color:var(--muted);margin:0 0 18px}
  label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
  input{width:100%;padding:9px 12px;border:1px solid var(--line-strong);border-radius:8px;font:inherit;font-size:15px;margin-bottom:14px;background:var(--surface);color:var(--text)}
  input:focus{outline:3px solid var(--accent-soft);border-color:var(--accent)}
  button{width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer}
  button:hover{background:var(--accent-hover)}
  .err{background:var(--red-bg);color:var(--red);font-size:13px;padding:8px 12px;border-radius:8px;margin-bottom:14px}
  .ok{width:44px;height:44px;border-radius:50%;background:var(--green-bg);color:var(--green);display:grid;place-items:center;margin-bottom:14px}
</style></head><body><div class="wrap">${body}</div></body></html>`;

const MARK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
const CHECK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

/** Only same-site paths, so a crafted link can't send people elsewhere after signing in. */
export const safeNext = (v: unknown) => (typeof v === 'string' && /^\/(?![\/\\])/.test(v) ? v : '/');

/** `platform`: on SleekSky, account owners and staff sign in through the platform; the passcode still works too. */
export const loginPage = (error?: string, appName = DEFAULT_APP_NAME, next = '/', platform = false) =>
  shell(
    `${escapeHtml(appName)} · Sign in`,
    `<div class="brand"><span class="mark">${MARK}</span>${escapeHtml(appName)}</div>
     <div class="card"><h1>Sign in</h1>
     ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
     ${platform ? `<form method="get" action="/auth/platform">${next !== '/' ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''}<button type="submit">Sign in with SleekSky</button></form><p style="margin-top:18px">Or enter this app's passcode.</p>` : `<p>Enter this app's passcode.</p>`}
     <form method="post" action="/login">${next !== '/' ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''}<label for="pc">Passcode</label><input id="pc" type="password" name="passcode" autofocus autocomplete="current-password" required>
     <button type="submit">Sign in</button></form></div>`,
  );

/** First run: the first admin chooses the passcode for the app, the API and MCP. */
export const setupPage = (error?: string, appName = DEFAULT_APP_NAME, min = 12) =>
  shell(
    `${escapeHtml(appName)} · Set up`,
    `<div class="brand"><span class="mark">${MARK}</span>${escapeHtml(appName)}</div>
     <div class="card"><h1>Set up</h1><p>Choose the passcode for this app. You'll use it to sign in, and as the key for the API and MCP. Everything else is set in the app.</p>
     ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
     <form method="post" action="/setup"><label for="pc">Passcode</label><input id="pc" type="password" name="passcode" minlength="${min}" autofocus autocomplete="new-password" required>
     <label for="pc2">Passcode again</label><input id="pc2" type="password" name="again" minlength="${min}" autocomplete="new-password" required>
     <button type="submit">Set up</button></form></div>`,
  );

export const unsubscribePage = (state: 'confirm' | 'done' | 'invalid', email?: string) =>
  shell(
    'Unsubscribe',
    `<div class="card">${
      state === 'invalid'
        ? '<h1>Link not valid</h1><p style="margin:0">This unsubscribe link is not valid or has expired.</p>'
        : state === 'done'
          ? `<div class="ok">${CHECK}</div><h1>You're unsubscribed</h1><p style="margin:0"><b>${escapeHtml(email || '')}</b> won't receive any more emails from us.</p>`
          : `<h1>Unsubscribe</h1><p>Stop receiving emails at <b>${escapeHtml(email || '')}</b>?</p>
             <form method="post"><button type="submit">Unsubscribe</button></form>`
    }</div>`,
  );

export const appPage = (appName = DEFAULT_APP_NAME) => APP_HTML.replaceAll('{{APP_NAME}}', escapeHtml(appName));
