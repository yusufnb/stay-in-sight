import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import { processDue } from '../src/sender';
import { stringToSign, spkiFromCert, pemToDer, SnsMessage } from '../src/sns';
import type { Env } from '../src/util';

const require = createRequire(import.meta.url);
const selfsigned = require('selfsigned');
const nodeCrypto = require('node:crypto');

const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';
const pems = await selfsigned.generate([{ name: 'commonName', value: 'sns.amazonaws.com' }], { keySize: 2048, days: 1, algorithm: 'sha256' });

/** An SNS message signed like AWS does (SignatureVersion 2 = SHA256withRSA). */
function snsMessage(fields: Partial<SnsMessage>): SnsMessage {
  const m = { MessageId: 'm-1', TopicArn: 'arn:aws:sns:us-east-1:123:ses-events', Timestamp: new Date().toISOString(), SignatureVersion: '2', SigningCertURL: CERT_URL, Message: '', Type: 'Notification', ...fields } as SnsMessage;
  m.Signature = nodeCrypto.createSign('RSA-SHA256').update(stringToSign(m)).sign(pems.private, 'base64');
  return m;
}

/** A Cloudflare Email Routing message as the Worker's email() handler receives it. */
function inboundMail(to: string, from: string, subject: string, body: string, extraHeaders = '') {
  const raw = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@mail.test>\r\n${extraHeaders}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
  return {
    from: from.replace(/.*<|>.*/g, ''),
    to,
    headers: new Headers(),
    raw: new Response(raw).body!,
    rawSize: raw.length,
    setReject: vi.fn(),
    forward: vi.fn(async () => {}),
    reply: vi.fn(),
  };
}

describe('AWS SES mailboxes', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let sesCalls: { url: string; auth: string; body: any }[];
  let verified: Set<string>;
  let ctx: ExecutionContext;
  let worker: any;

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test', OPENROUTER_API_KEY: 'k' };
    sesCalls = [];
    verified = new Set(['ex.com']);
    ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    worker = (await import('../src/index')).default;
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const u = new URL(req.url);
      if (u.hostname === 'email.us-east-1.amazonaws.com') {
        const body = req.method === 'POST' ? await req.json() : null;
        sesCalls.push({ url: u.pathname, auth: req.headers.get('authorization') || '', body });
        if (u.pathname === '/v2/email/account') return Response.json({ ProductionAccessEnabled: false, SendingEnabled: true, SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 } });
        const id = decodeURIComponent(u.pathname.split('/identities/')[1] || '');
        if (id) return verified.has(id) ? Response.json({ VerifiedForSendingStatus: true }) : Response.json({ message: 'not found' }, { status: 404 });
        if (u.pathname === '/v2/email/outbound-emails') return Response.json({ MessageId: `ses-${sesCalls.length}` });
      }
      if (req.url === CERT_URL) return new Response(pems.cert);
      if (u.hostname === 'sns.us-east-1.amazonaws.com' && u.searchParams.get('Action') === 'ConfirmSubscription') return new Response('<ok/>');
      if (u.hostname === 'openrouter.ai') {
        const b = JSON.parse(await req.text());
        const text: string = b.messages[1].content.split('\"\"\"')[1] || '';
        return Response.json({ choices: [{ message: { content: /website/i.test(text) ? 'new_site' : 'interested' } }], usage: { cost: 0.00002 } });
      }
      if (u.hostname === 'hook.test') return new Response('ok');
      return new Response(`not mocked: ${req.url}`, { status: 500 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const addMailbox = (extra: Record<string, unknown> = {}) =>
    svc.createSesMailbox(env, { email: 'Hello@Ex.com', name: 'Ex Team', region: 'us-east-1', access_key_id: 'AKIATEST1234', secret_access_key: 'S3cr3t-Value-xyz', reply_domain: 'Reply.Ex.com', configuration_set: 'outbound', ...extra } as never);

  it('adds a mailbox only with working keys and a verified identity, and never returns the secret', async () => {
    verified = new Set();
    await expect(addMailbox()).rejects.toThrow(/verified identity/);
    verified = new Set(['ex.com']);
    await expect(addMailbox({ reply_domain: 'not a domain' })).rejects.toThrow(/valid domain/);
    const mb = await addMailbox();
    expect(mb).toMatchObject({ email: 'hello@ex.com', provider: 'ses', connected: true, reply_domain: 'reply.ex.com', ses: { region: 'us-east-1', access_key_id: '…1234', has_secret: true, configuration_set: 'outbound', status: { production_access: false, verified_identity: 'ex.com', max_24h: 200 } } });
    expect(JSON.stringify(mb)).not.toContain('S3cr3t-Value-xyz');
    expect(JSON.stringify(await svc.listMailboxes(env))).not.toContain('S3cr3t-Value-xyz');
    expect(sesCalls[0].auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST1234\/\d{8}\/us-east-1\/ses\/aws4_request/);
    await expect(addMailbox()).rejects.toThrow(/already exists/);
  });

  it('sends through SES with a tracked Reply-To and the configuration set', async () => {
    await addMailbox();
    const r = await svc.scheduleEmails(env, [{ mailbox: 'hello@ex.com', to: 'jane@acme.com', subject: 'Hi', body: 'Hello Jane' }]);
    expect(await processDue(env)).toMatchObject({ sent: 1 });
    const send = sesCalls.find((c) => c.url === '/v2/email/outbound-emails')!;
    expect(send.body.ConfigurationSetName).toBe('outbound');
    const mime = atob(send.body.Content.Raw.Data);
    const e = await svc.getEmailRow(env, r.scheduled[0].id);
    expect(mime).toContain('From: "Ex Team" <hello@ex.com>');
    expect(mime).toContain(`Reply-To: reply+${e.track_token}@reply.ex.com`);
    expect(mime).toContain(`<mailto:reply+${e.track_token}@reply.ex.com?subject=STOP>`);
    expect(e).toMatchObject({ status: 'sent', ses_message_id: expect.stringMatching(/^ses-\d+$/), gmail_thread_id: null });

    // Any address on a verified domain may be the From; other domains can't
    await svc.scheduleEmails(env, [{ mailbox: 1, to: 'b@x.com', subject: 's', body: 'b', from_email: 'sales@ex.com' }]);
    await expect(svc.scheduleEmails(env, [{ mailbox: 1, to: 'b@x.com', subject: 's', body: 'b', from_email: 'me@other.com' }])).rejects.toThrow(/verified identity/);
  });

  it('records replies that arrive through Cloudflare Email Routing, and forwards a copy', async () => {
    await addMailbox({ forward_to: 'team@ex.com' });
    await svc.updateMailbox(env, 1, { webhook_url: 'https://hook.test/r' });
    const r = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'jane@acme.com', subject: 'Hi', body: 'Hello Jane' }]);
    await processDue(env);
    const token = (await svc.getEmailRow(env, r.scheduled[0].id)).track_token;

    const msg = inboundMail(`reply+${token}@reply.ex.com`, 'Jane Doe <jane@acme.com>', 'Re: Hi', 'We need a new website, can you help?\r\n\r\nOn Mon, Ex Team <hello@ex.com> wrote:\r\n> Hello Jane');
    await worker.email(msg, env, ctx);
    expect(msg.setReject).not.toHaveBeenCalled();
    expect(msg.forward).toHaveBeenCalledWith('team@ex.com');
    const reply = (await svc.listReplies(env, {})).replies[0];
    expect(reply).toMatchObject({ from: 'jane@acme.com', from_name: 'Jane Doe', kind: 'reply', text: 'We need a new website, can you help?', category: 'new_site' });
    expect((await svc.getEmailRow(env, r.scheduled[0].id)).reply_count).toBe(1);
    const conv = await svc.conversation(env, r.scheduled[0].id);
    expect(conv.map((c) => c.role)).toEqual(['us', 'them']);

    // STOP via the unsubscribe mailto (empty body, subject STOP) → do-not-send
    await worker.email(inboundMail(`reply+${token}@reply.ex.com`, 'jane@acme.com', 'STOP', ''), env, ctx);
    expect(await svc.isDnc(env, 'jane@acme.com')).toBe(true);

    // Out-of-office is recorded as auto, not a reply
    await worker.email(inboundMail(`reply+${token}@reply.ex.com`, 'jane@acme.com', 'Automatic reply: Hi', 'I am away', 'Auto-Submitted: auto-replied\r\n'), env, ctx);
    expect((await svc.listReplies(env, { kind: 'auto' })).total).toBe(1);

    // Unknown addresses are rejected
    const stray = inboundMail('reply+nottherightoken@reply.ex.com', 'x@y.com', 'hi', 'hi');
    await worker.email(stray, env, ctx);
    expect(stray.setReject).toHaveBeenCalled();
    const other = inboundMail('info@reply.ex.com', 'x@y.com', 'hi', 'hi');
    await worker.email(other, env, ctx);
    expect(other.setReject).toHaveBeenCalled();
  });

  it('SNS webhook: verifies signatures, confirms the subscription, and acts on bounces and complaints', async () => {
    await addMailbox();
    const r = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'gone@acme.com', subject: 'Hi', body: 'b' }, { mailbox: 1, to: 'angry@acme.com', subject: 'Hi', body: 'b' }]);
    db.raw.exec('UPDATE mailboxes SET throttle_minutes = 1');
    await processDue(env, r.scheduled.map((x) => x.id));
    const [e1, e2] = await Promise.all(r.scheduled.map((x) => svc.getEmailRow(env, x.id)));
    const token = (await (await worker.fetch(new Request('https://ob.test/api/config', { headers: { authorization: 'Bearer pw' } }), env, ctx)).json()).ses_webhook_endpoint.split('token=')[1];
    const post = (m: unknown, t = token) => worker.fetch(new Request(`https://ob.test/webhooks/ses?token=${t}`, { method: 'POST', body: JSON.stringify(m) }), env, ctx);

    // The certificate parser pulls out a usable public key
    expect(spkiFromCert(pemToDer(pems.cert)).length).toBeGreaterThan(200);

    // Subscription confirmation
    const sub = snsMessage({ Type: 'SubscriptionConfirmation', Message: 'confirm', Token: 'tok', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok' });
    expect((await post(sub)).status).toBe(200);
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u instanceof Request ? u.url : u).includes('ConfirmSubscription'))).toBe(true);

    // Hard bounce → bounced + do-not-send
    const bounce = snsMessage({ Message: JSON.stringify({ eventType: 'Bounce', mail: { messageId: e1.ses_message_id }, bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'gone@acme.com', diagnosticCode: '550 5.1.1 user unknown' }] } }) });
    expect((await post(bounce)).status).toBe(200);
    expect(await svc.getEmailRow(env, e1.id)).toMatchObject({ status: 'bounced', status_reason: 'hard bounce: 550 5.1.1 user unknown' });
    expect((await svc.dncList(env, {})).entries.find((d) => d.email === 'gone@acme.com')).toMatchObject({ source: 'bounce' });

    // Complaint → do-not-send (identity-notification format)
    const complaint = snsMessage({ Message: JSON.stringify({ notificationType: 'Complaint', mail: { messageId: e2.ses_message_id }, complaint: { complainedRecipients: [{ emailAddress: 'angry@acme.com' }] } }) });
    expect((await post(complaint)).status).toBe(200);
    expect((await svc.dncList(env, {})).entries.find((d) => d.email === 'angry@acme.com')).toMatchObject({ source: 'complaint' });

    // Rejected: wrong token, tampered body, bad signature, foreign certificate host
    expect((await post(bounce, 'wrong')).status).toBe(403);
    expect((await post({ ...bounce, Message: bounce.Message.replace('gone@', 'someone@') })).status).toBe(403);
    expect((await post({ ...bounce, Signature: 'AAAA' })).status).toBe(403);
    expect((await post({ ...bounce, SigningCertURL: 'https://evil.example.com/cert.pem' })).status).toBe(403);
    expect(await svc.isDnc(env, 'someone@acme.com')).toBe(false);
  });

  it('Gmail-only work skips SES mailboxes', async () => {
    await addMailbox();
    const { syncAll, renewWatches } = await import('../src/sync');
    expect(await syncAll(env)).toEqual({ mailboxes: 0, processed: 0 });
    expect(await renewWatches({ ...env, GMAIL_PUBSUB_TOPIC: 'projects/p-123/topics/t' }, true)).toEqual({ renewed: 0 });
    expect((await svc.refreshSendAs(env, (await svc.listMailboxRows(env))[0])).map((a) => a.email)).toEqual(['hello@ex.com']);
  });
});
