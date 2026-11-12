import { Env, HttpError, now } from './util';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export interface MailboxRow {
  id: number;
  email: string;
  name: string | null;
  refresh_token: string;
  access_token: string | null;
  token_expires_at: number | null;
  history_id: string | null;
  watch_expires_at: number | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  daily_limit: number;
  throttle_minutes: number;
  from_email: string | null;
  reply_to: string | null;
  send_as: string | null;
  provider: string; // 'google' | 'ses'
  ses_region: string | null;
  ses_access_key_id: string | null;
  ses_secret_access_key: string | null;
  ses_configuration_set: string | null;
  ses_status: string | null;
  reply_domain: string | null;
  forward_to: string | null;
  purpose: string; // 'outreach' | 'newsletter' | 'conversation'
  track_opens: number | null;
  list_unsubscribe: number | null;
  footer: string | null;
  warmup_enabled: number;
  warmup_start: number;
  warmup_step: number;
  warmup_started_at: number | null;
  group_id: number | null;
  active: number;
  last_sync_at: number | null;
  last_error: string | null;
  created_at: number;
}

function requireGoogle(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(500, 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
  }
  return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
}

export function googleAuthUrl(env: Env, redirectUri: string, state: string, loginHint?: string): string {
  const { id } = requireGoogle(env);
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // always get a refresh token
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(env: Env, body: Record<string, string>): Promise<TokenResponse> {
  const { id, secret } = requireGoogle(env);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...body }),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) throw new Error(`Google token error: ${json.error} ${json.error_description || ''}`.trim());
  return json;
}

export async function exchangeCode(env: Env, code: string, redirectUri: string) {
  const tok = await tokenRequest(env, { code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const info = (await (
    await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })
  ).json()) as { email?: string; name?: string };
  if (!info.email) throw new Error('Could not read the Google account email');
  return { ...tok, email: info.email.toLowerCase(), name: info.name || null };
}

export async function accessToken(env: Env, mb: MailboxRow): Promise<string> {
  if (mb.access_token && mb.token_expires_at && mb.token_expires_at - 60_000 > now()) return mb.access_token;
  const tok = await tokenRequest(env, { refresh_token: mb.refresh_token, grant_type: 'refresh_token' });
  const exp = now() + tok.expires_in * 1000;
  await env.DB.prepare('UPDATE mailboxes SET access_token = ?, token_expires_at = ? WHERE id = ?').bind(tok.access_token, exp, mb.id).run();
  mb.access_token = tok.access_token;
  mb.token_expires_at = exp;
  return tok.access_token;
}

export class GmailError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gmail<T>(env: Env, mb: MailboxRow, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(env, mb);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GmailError(res.status, `Gmail ${init.method || 'GET'} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export const gmailApi = {
  /** threadId: put the message in an existing Gmail thread (needs matching In-Reply-To/References and subject). */
  send: (env: Env, mb: MailboxRow, raw: string, threadId?: string | null) =>
    gmail<{ id: string; threadId: string }>(env, mb, '/messages/send', { method: 'POST', body: JSON.stringify(threadId ? { raw, threadId } : { raw }) }),

  getMessage: (env: Env, mb: MailboxRow, id: string, format: 'full' | 'metadata' = 'full') =>
    gmail<GmailMessage>(env, mb, `/messages/${id}?format=${format}`),

  getThread: (env: Env, mb: MailboxRow, id: string) => gmail<{ id: string; messages: GmailMessage[] }>(env, mb, `/threads/${id}?format=full`),

  /** Addresses this account can send as (primary + "Send mail as" aliases). */
  sendAs: (env: Env, mb: MailboxRow) =>
    gmail<{ sendAs?: { sendAsEmail: string; displayName?: string; isPrimary?: boolean; verificationStatus?: string }[] }>(env, mb, '/settings/sendAs'),

  profile: (env: Env, mb: MailboxRow) => gmail<{ emailAddress: string; historyId: string }>(env, mb, '/profile'),

  history: (env: Env, mb: MailboxRow, startHistoryId: string, pageToken?: string) => {
    const p = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '500' });
    if (pageToken) p.set('pageToken', pageToken);
    return gmail<{
      history?: { id: string; messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[] }[];
      historyId: string;
      nextPageToken?: string;
    }>(env, mb, `/history?${p}`);
  },

  watch: (env: Env, mb: MailboxRow, topicName: string) =>
    gmail<{ historyId: string; expiration: string }>(env, mb, '/watch', {
      method: 'POST',
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
    }),
};
