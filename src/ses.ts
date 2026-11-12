import { AwsClient } from 'aws4fetch';
import type { MailboxRow } from './google';
import { HttpError } from './util';

/** Reply-To for an SES email: reply+<track_token>@<reply domain>, routed back by Cloudflare Email Routing. */
export const trackedReplyAddress = (mb: MailboxRow, token: string) => (mb.reply_domain ? `reply+${token}@${mb.reply_domain}` : null);

export const SES_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'me-south-1', 'af-south-1', 'il-central-1',
];

export interface SesCreds {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class SesError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const credsOf = (mb: MailboxRow): SesCreds => ({
  region: mb.ses_region || 'us-east-1',
  accessKeyId: mb.ses_access_key_id || '',
  secretAccessKey: mb.ses_secret_access_key || '',
});

async function ses<T>(c: SesCreds, method: string, path: string, body?: unknown): Promise<T> {
  if (!c.accessKeyId || !c.secretAccessKey) throw new HttpError(400, 'SES access key is not set');
  const aws = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, service: 'ses' });
  const res = await aws.fetch(`https://email.${c.region}.amazonaws.com${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; Message?: string };
      msg = j.message || j.Message || msg;
    } catch {
      /* not JSON */
    }
    throw new SesError(res.status, `SES ${method} ${path.split('?')[0]} → ${res.status}: ${msg}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Send a complete MIME message. Returns SES's MessageId (used to match bounce/complaint events). */
export async function sesSendRaw(mb: MailboxRow, mime: string): Promise<string> {
  const r = await ses<{ MessageId: string }>(credsOf(mb), 'POST', '/v2/email/outbound-emails', {
    Content: { Raw: { Data: btoa(mime) } },
    ...(mb.ses_configuration_set ? { ConfigurationSetName: mb.ses_configuration_set } : {}),
  });
  return r.MessageId;
}

/** Account check: are the keys valid, is sending enabled, are we still in the sandbox, and is the From address verified? */
export async function sesCheck(c: SesCreds, fromEmail: string) {
  const acct = await ses<{
    ProductionAccessEnabled?: boolean;
    SendingEnabled?: boolean;
    EnforcementStatus?: string;
    SendQuota?: { Max24HourSend?: number; MaxSendRate?: number; SentLast24Hours?: number };
  }>(c, 'GET', '/v2/email/account');
  const domain = fromEmail.split('@')[1] || '';
  let verified: string | null = null;
  for (const id of [fromEmail, domain]) {
    try {
      const r = await ses<{ VerifiedForSendingStatus?: boolean }>(c, 'GET', `/v2/email/identities/${encodeURIComponent(id)}`);
      if (r.VerifiedForSendingStatus) {
        verified = id;
        break;
      }
    } catch (err) {
      if (!(err instanceof SesError && err.status === 404)) throw err;
    }
  }
  return {
    checked_at: new Date().toISOString(),
    sending_enabled: acct.SendingEnabled !== false,
    production_access: !!acct.ProductionAccessEnabled,
    enforcement: acct.EnforcementStatus || null,
    max_24h: acct.SendQuota?.Max24HourSend ?? null,
    max_per_second: acct.SendQuota?.MaxSendRate ?? null,
    sent_24h: acct.SendQuota?.SentLast24Hours ?? null,
    verified_identity: verified,
  };
}
