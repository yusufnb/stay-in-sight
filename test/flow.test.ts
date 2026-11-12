import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import { processDue } from '../src/sender';
import { syncMailbox, deliverWebhooks } from '../src/sync';
import * as svc from '../src/service';
import * as tmpl from '../src/templates';
import { b64urlDecodeStr, b64urlEncodeStr, type Env } from '../src/util';

const b64 = (s: string) => b64urlEncodeStr(s);
const gmsg = (id: string, from: string, text: string, labels = ['INBOX'], extra: Record<string, string> = {}) => ({
  id, threadId: 'T1', labelIds: labels, internalDate: String(Date.now()),
  payload: { mimeType: 'text/plain', headers: Object.entries({ From: from, Subject: 'Re: Hello', 'Content-Type': 'text/plain; charset=UTF-8', ...extra }).map(([name, value]) => ({ name, value })), body: { size: 1, data: b64(text) } },
});

describe('send → reply → STOP flow', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let sentRaw: string[];
  let hooks: { url: string; body: any; headers: Record<string, string> }[];
  let inbox: Record<string, ReturnType<typeof gmsg>>;
  let aiCalls: any[];
  let history: { id: string; messagesAdded: { message: { id: string; threadId: string; labelIds: string[] } }[] }[];

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', PUBLIC_URL: 'https://ob.test' };
    sentRaw = []; hooks = []; inbox = {}; history = []; aiCalls = [];
    db.raw.exec(`INSERT INTO mailboxes (email, name, refresh_token, access_token, token_expires_at, history_id, webhook_url, webhook_secret, created_at)
      VALUES ('me@ex.com', 'Me', 'rt', 'at', ${Date.now() + 3600_000}, '100', 'https://hook.test/r', 'sec', 0)`);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      if (u.host === 'openrouter.ai') {
        const body = JSON.parse(init.body as string);
        aiCalls.push(body);
        const text: string = body.messages[1].content.split('"""')[1] || '';
        if (/explode/.test(text)) return Response.json({ error: { message: 'upstream exploded' } }, { status: 502 });
        const answer = /take me off/i.test(text) ? 'stop' : /website/i.test(text) ? 'Category: new_site.' : /maybe/i.test(text) ? 'banana' : 'interested';
        return Response.json({ choices: [{ message: { content: answer } }], usage: { cost: 0.00002 } });
      }
      if (u.host === 'hook.test') {
        hooks.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
        return new Response('ok');
      }
      const p = u.pathname.replace('/gmail/v1/users/me', '');
      if (p === '/messages/send') {
        sentRaw.push(JSON.parse(init.body as string).raw);
        return Response.json({ id: 'S1', threadId: 'T1' });
      }
      if (p === '/history') return Response.json({ history, historyId: '200' });
      if (p === '/settings/sendAs') return Response.json({ sendAs: [
        { sendAsEmail: 'me@ex.com', isPrimary: true, displayName: 'Me' },
        { sendAsEmail: 'Sales@Ex.com', displayName: 'Ex Sales', verificationStatus: 'accepted' },
        { sendAsEmail: 'pending@ex.com', verificationStatus: 'pending' },
      ] });
      if (p === '/watch') return Response.json({ historyId: '300', expiration: String(Date.now() + 7 * 86_400_000) });
      if (p.startsWith('/messages/')) return Response.json(inbox[p.split('/')[2]]);
      if (p === '/threads/T1') return Response.json({ id: 'T1', messages: [gmsg('S1', 'Me <me@ex.com>', 'Hello Jane', ['SENT']), ...Object.values(inbox)] });
      return new Response('not mocked ' + url, { status: 500 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends due mail, records replies with conversation webhook, and handles STOP', async () => {
    const r = await svc.scheduleEmails(env, [
      { mailbox: 'me@ex.com', to: 'jane@acme.com', subject: 'Hello', body: 'Hello Jane', campaign: 'c1' },
      { mailbox: 'me@ex.com', to: 'jane@acme.com', subject: 'Follow up', body: 'Bump', campaign: 'c1', send_at: '2099-01-01T00:00:00Z' },
    ]);
    expect(r.scheduled).toHaveLength(2);

    expect(await processDue(env)).toMatchObject({ sent: 1 });
    expect(b64urlDecodeStr(sentRaw[0])).toContain('To: jane@acme.com');
    const sent = await svc.getEmailRow(env, 1);
    expect(sent).toMatchObject({ status: 'sent', gmail_thread_id: 'T1' });

    // A normal reply, plus an unrelated message in another thread
    inbox.R1 = gmsg('R1', 'Jane <jane@acme.com>', 'Sounds good!\n\nOn Mon, Me <me@ex.com> wrote:\n> Hello Jane');
    history = [{ id: '150', messagesAdded: [{ message: { id: 'R1', threadId: 'T1', labelIds: ['INBOX'] } }, { message: { id: 'X', threadId: 'OTHER', labelIds: ['INBOX'] } }] }];
    expect(await syncMailbox(env, (await svc.listMailboxRows(env))[0])).toEqual({ processed: 1 });
    expect(await deliverWebhooks(env)).toMatchObject({ delivered: 1 });
    expect(hooks[0].body.reply.text).toBe('Sounds good!');
    expect(hooks[0].body.conversation.map((m: any) => [m.role, m.text])).toEqual([['us', 'Hello Jane'], ['them', 'Sounds good!']]);
    expect(hooks[0].headers['x-outbound-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Re-sync of the same history must not duplicate
    const mb = (await svc.listMailboxRows(env))[0];
    mb.history_id = '100';
    expect(await syncMailbox(env, mb)).toEqual({ processed: 0 });

    // STOP reply → DNC + pending follow-up skipped
    inbox.R2 = gmsg('R2', 'Jane <jane@acme.com>', 'STOP');
    history = [{ id: '160', messagesAdded: [{ message: { id: 'R2', threadId: 'T1', labelIds: ['INBOX'] } }] }];
    await syncMailbox(env, (await svc.listMailboxRows(env))[0]);
    expect(await svc.isDnc(env, 'jane@acme.com')).toBe(true);
    expect((await svc.getEmailRow(env, 2)).status).toBe('skipped');
    await deliverWebhooks(env);
    expect(hooks[1].body.event).toBe('reply.stop');

    // Auto-reply is recorded but not sent to the webhook
    inbox.R3 = gmsg('R3', 'Jane <jane@acme.com>', 'I am out', ['INBOX'], { 'Auto-Submitted': 'auto-replied' });
    history = [{ id: '170', messagesAdded: [{ message: { id: 'R3', threadId: 'T1', labelIds: ['INBOX'] } }] }];
    await syncMailbox(env, (await svc.listMailboxRows(env))[0]);
    await deliverWebhooks(env);
    expect(hooks).toHaveLength(2);

    const [c] = await svc.listCampaigns(env);
    expect(c).toMatchObject({ campaign: 'c1', sent: 1, replied: 1, stopped: 1, skipped: 1, reply_rate: 100 });
    expect((await svc.getEmailRow(env, 1)).reply_count).toBe(2);
  });

  it('respects the daily limit and DNC at send time', async () => {
    db.raw.exec('UPDATE mailboxes SET daily_limit = 1');
    await svc.scheduleEmails(env, [
      { mailbox: 1, to: 'a@x.com', subject: 's', body: 'b' },
      { mailbox: 1, to: 'b@x.com', subject: 's', body: 'b' },
      { mailbox: 1, to: 'c@x.com', subject: 's', body: 'b' },
    ]);
    await svc.dncAdd(env, ['c@x.com'], null, 'manual');
    expect(await processDue(env)).toMatchObject({ sent: 1, deferred: 1 });
    expect((await svc.getEmailRow(env, 3)).status).toBe('skipped');
  });

  it('throttles sends per mailbox and records why an email is waiting', async () => {
    db.raw.exec('UPDATE mailboxes SET throttle_minutes = 10');
    await svc.scheduleEmails(env, [
      { mailbox: 1, to: 'a@x.com', subject: 's', body: 'b' },
      { mailbox: 1, to: 'b@x.com', subject: 's', body: 'b' },
    ]);
    expect(await processDue(env)).toMatchObject({ sent: 1, deferred: 1 });
    expect((await svc.getEmailRow(env, 2)).status_reason).toMatch(/throttle/);
    // Next tick, still inside the 10 minute gap
    expect(await processDue(env)).toMatchObject({ sent: 0, deferred: 1 });
    // "Send now" on explicit ids skips the throttle
    expect(await processDue(env, [2])).toMatchObject({ sent: 1 });
  });

  it('auto-schedules by throttle and daily limit, around what is already queued', async () => {
    db.raw.exec('UPDATE mailboxes SET throttle_minutes = 15, daily_limit = 3');
    const first = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'q@x.com', subject: 's', body: 'b', send_at: Date.now() + 3600_000 }]);
    const emails = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ mailbox: 'me@ex.com', to: `${n}@x.com`, subject: 's', body: 'b', send_at: '2000-01-01T00:00:00Z' }));
    emails.push({ mailbox: 'me@ex.com', to: 'jane@acme.com', subject: 's', body: 'b', send_at: '' });
    await svc.dncAdd(env, ['jane@acme.com'], null, 'manual');
    const r: any = await svc.scheduleEmails(env, emails, { auto: true });
    expect(r.skipped).toHaveLength(1);
    expect(r.plan[0]).toMatchObject({ mailbox: 'me@ex.com', count: 5, daily_limit: 3, throttle_minutes: 15 });
    const times = [first.scheduled[0].send_at, ...r.scheduled.map((x: any) => x.send_at)].map((t: string) => Date.parse(t)).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(15 * 60_000);
    for (const t of times) expect(times.filter((x) => x >= t && x < t + 86_400_000).length).toBeLessThanOrEqual(3);
    expect(Date.parse(r.scheduled[0].send_at)).toBeGreaterThanOrEqual(Date.now() - 5000); // send_at in the input is ignored
    const preview = await svc.previewPlan(env, 1, 2);
    expect(preview.slots).toHaveLength(2);
    expect(Date.parse(preview.slots[0])).toBeGreaterThan(Date.parse(r.scheduled[4].send_at));
  });

  it('never allows empty or unlimited mailbox limits', async () => {
    await expect(svc.updateMailbox(env, 1, { daily_limit: 0 })).rejects.toThrow(/daily_limit/);
    await expect(svc.updateMailbox(env, 1, { throttle_minutes: '' as never })).rejects.toThrow(/throttle_minutes/);
    await expect(svc.updateMailbox(env, 1, { daily_limit: 2.5 })).rejects.toThrow(/daily_limit/);
    expect(await svc.updateMailbox(env, 1, { daily_limit: 80, throttle_minutes: 3 })).toMatchObject({ daily_limit: 80, throttle_minutes: 3 });
  });

  it('templates: render from CSV vars and never reach the same address twice', async () => {
    const tpl = await tmpl.createTemplate(env, { template_id: 'Intro-V1', name: 'Intro', subject: 'Idea for {{Company}}', body: '<p>Hi {{first_name}}, {{company}} rocks</p>' });
    expect(tpl).toMatchObject({ template_id: 'intro-v1', columns: ['to', 'company', 'first_name'] });
    await expect(tmpl.createTemplate(env, { template_id: 'intro-v1', subject: 'x', body: 'y' })).rejects.toThrow(/already exists/);

    const row = (to: string, extra: Record<string, string> = {}) => ({ mailbox: 1, to, template_id: 'intro-v1', vars: { first_name: 'Ann', company: 'A&B <Co>', ...extra } });
    const r1 = await svc.scheduleEmails(env, [row('a@x.com'), row('b@x.com'), row('A@x.com'), { ...row('c@x.com'), vars: { first_name: 'Cy' } }]);
    expect(r1.scheduled.map((x) => x.to)).toEqual(['a@x.com', 'b@x.com']);
    expect(r1.skipped.map((x) => x.reason)).toEqual(['duplicate row for this template', 'missing value for company']);

    const e1 = await svc.getEmailRow(env, r1.scheduled[0].id);
    expect(e1.subject).toBe('Idea for A&B <Co>'); // plain-text subject is not escaped
    expect(e1.body_html).toBe('<p>Hi Ann, A&amp;B &lt;Co&gt; rocks</p>'); // HTML body is
    expect(JSON.parse(e1.metadata!)).toEqual({ first_name: 'Ann', company: 'A&B <Co>' });

    // Re-upload the same list plus a new person: only the new person is scheduled
    await processDue(env, [r1.scheduled[0].id]); // a@x.com is now sent; b@x.com still scheduled
    const r2: any = await svc.scheduleEmails(env, [row('a@x.com'), row('b@x.com'), row('d@x.com')], { auto: true });
    expect(r2.scheduled.map((x: any) => x.to)).toEqual(['d@x.com']);
    expect(r2.skipped.map((x: any) => x.reason)).toEqual(['already received this template', 'template already scheduled for this address']);

    // Cancelled means never received: they can get it later
    await svc.cancelEmails(env, { to: 'b@x.com' });
    const r3 = await svc.scheduleEmails(env, [row('b@x.com')]);
    expect(r3.scheduled).toHaveLength(1);
    // ...but the old cancelled copy can't be re-queued now
    await expect(svc.updateScheduledEmail(env, r1.scheduled[1].id, { subject: 'again' })).rejects.toThrow(/already has template/);

    // Even a raw insert can't sneak a duplicate past the database
    expect(() => db.raw.exec(`INSERT INTO emails (mailbox_id, to_email, subject, send_at, track_token, template_id, status, created_at) VALUES (1, 'a@x.com', 's', 0, 'zz', 'intro-v1', 'scheduled', 0)`)).toThrow(/UNIQUE/);

    // Different template, same person: fine
    await tmpl.createTemplate(env, { template_id: 'followup-1', subject: 'Re: {{company}}', body: 'Bumping this' });
    expect((await svc.scheduleEmails(env, [{ mailbox: 1, to: 'a@x.com', template_id: 'followup-1', vars: { company: 'A' } }])).scheduled).toHaveLength(1);

    const check = await tmpl.checkTemplateRecipients(env, 'intro-v1', ['a@x.com', 'B@x.com', 'z@x.com']);
    expect(check).toMatchObject({ checked: 3, new_recipients: 1 });
    const stats = (await tmpl.getTemplate(env, 'intro-v1')).stats;
    expect(stats).toMatchObject({ sent: 1, scheduled: 2 });

    // template_id is fixed; content can change and columns follow
    expect((await tmpl.updateTemplate(env, 'intro-v1', { body: 'Hi {{first_name}} from {{city}}' })).columns).toEqual(['to', 'company', 'first_name', 'city']);
  });

  it('categorizes replies with the LLM: stop goes to do-not-send, the rest rides along on the webhook', async () => {
    env.OPENROUTER_API_KEY = 'k';
    const r = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'jane@acme.com', subject: 'Hello', body: 'Hello Jane, want a demo?' }]);
    await processDue(env);
    const mb = async () => (await svc.listMailboxRows(env))[0];
    const deliver = async (id: string, from: string, text: string) => {
      inbox[id] = gmsg(id, from, text);
      history = [{ id: '1' + id, messagesAdded: [{ message: { id, threadId: 'T1', labelIds: ['INBOX'] } }] }];
      const m = await mb();
      m.history_id = '100';
      await syncMailbox(env, m);
    };

    await deliver('A1', 'Jane <jane@acme.com>', 'We actually need a new website for our clinic, can you help?');
    await deliverWebhooks(env);
    expect(hooks[0].body.reply.category).toEqual({ name: 'new_site', description: expect.stringContaining('website') });
    expect(hooks[0].body.reply.category_source).toBe('ai');
    expect(hooks[0].headers['x-outbound-category']).toBe('new_site');
    expect(aiCalls[0].model).toBe('openai/gpt-6-luna');
    expect(aiCalls[0].messages[1].content).toContain('Our email subject: Hello'); // original email gives context
    expect(aiCalls[0].messages[0].role).toBe('system');
    const cat0 = await import('../src/categorize');
    await expect(cat0.setAiSettings(env, { context: 'x'.repeat(2001) })).rejects.toThrow(/2000/);
    await cat0.setAiSettings(env, { context: 'We build websites for clinics.' });
    expect(await svc.isDnc(env, 'jane@acme.com')).toBe(false);

    // Polite opt-out without the word STOP: the model decides, and they land on do-not-send
    await deliver('A2', 'Bob <bob@acme.com>', 'Please take me off this list, thanks.');
    expect(aiCalls[aiCalls.length - 1].messages[0].content).toContain('About us and our outreach:\nWe build websites for clinics.');
    expect(await svc.isDnc(env, 'bob@acme.com')).toBe(true);
    await deliverWebhooks(env);
    expect(hooks[1].body).toMatchObject({ event: 'reply.stop', reply: { is_stop: true, category: { name: 'stop' } } });

    // A literal STOP never calls the model
    const before = aiCalls.length;
    await deliver('A3', 'Cy <cy@acme.com>', 'STOP');
    expect(aiCalls.length).toBe(before);
    const stopReply = (await svc.listReplies(env, { category: 'stop' })).replies.find((x) => x.from === 'cy@acme.com');
    expect(stopReply).toMatchObject({ kind: 'stop', category_source: 'rule' });

    // Model failure: no category yet, error kept, retried before the webhook goes out
    await deliver('A4', 'Di <di@acme.com>', 'explode please');
    const failed = (await svc.listReplies(env, {})).replies.find((x) => x.from === 'di@acme.com')!;
    expect(failed).toMatchObject({ category: null, category_error: expect.stringContaining('upstream exploded') });

    // Unknown answer from the model is not accepted
    await deliver('A5', 'Ed <ed@acme.com>', 'maybe later');
    expect((await svc.listReplies(env, {})).replies.find((x) => x.from === 'ed@acme.com')).toMatchObject({ category: null, category_error: expect.stringContaining('banana') });

    // Manual re-label to stop adds them to do-not-send
    const { applyCategory } = await import('../src/sync');
    const edReply = (await svc.listReplies(env, {})).replies.find((x) => x.from === 'ed@acme.com')!;
    await applyCategory(env, edReply.id, 'stop', 'manual');
    expect(await svc.isDnc(env, 'ed@acme.com')).toBe(true);

    // Categories: stop is permanent, others are editable
    const cat = await import('../src/categorize');
    await expect(cat.deleteCategory(env, 'stop')).rejects.toThrow(/can't be deleted/);
    await expect(cat.saveCategory(env, { name: 'stop', description: 'x', rename_to: 'halt' })).rejects.toThrow(/can't be renamed/);
    await cat.saveCategory(env, { name: 'Pricing Question', description: 'Asks about price' });
    expect((await cat.listCategories(env)).map((c) => c.name)).toContain('pricing_question');
    await cat.saveCategory(env, { name: 'new_site', description: 'Wants a website', rename_to: 'website' });
    expect((await svc.listReplies(env, { category: 'website' })).replies).toHaveLength(1); // past replies follow the rename
    expect(r.scheduled).toHaveLength(1);
  });

  it('settings saved in the app override deploy-time values and fall back when cleared', async () => {
    const cfg = await import('../src/config');
    const { saveSettings, readSettings } = await import('../src/settings');
    cfg._resetConfigCache();
    const deploy = { ...env, GOOGLE_CLIENT_ID: 'deploy.apps.googleusercontent.com', SEND_BATCH: '20', PASSCODE: 'pw' } as Env;

    let e = await cfg.withConfig(deploy);
    expect(e.GOOGLE_CLIENT_ID).toBe('deploy.apps.googleusercontent.com');
    expect(e.DEPLOY_ENV).toBe(deploy);

    await saveSettings(e, { GOOGLE_CLIENT_ID: 'app.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh', SEND_BATCH: '7' });
    e = await cfg.withConfig(deploy);
    expect(e).toMatchObject({ GOOGLE_CLIENT_ID: 'app.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh', SEND_BATCH: '7', PASSCODE: 'pw' });

    const list = await readSettings(e);
    const byKey = Object.fromEntries(list.map((x) => [x.key, x]));
    expect(byKey.GOOGLE_CLIENT_SECRET).toMatchObject({ source: 'app', is_set: true, value: null }); // never echoed back
    expect(byKey.GOOGLE_CLIENT_ID).toMatchObject({ source: 'app', value: 'app.apps.googleusercontent.com', deploy_value: 'deploy.apps.googleusercontent.com' });
    expect(byKey.OPENROUTER_API_KEY).toMatchObject({ source: 'none', is_set: false });

    // Clearing falls back to the deploy value
    await saveSettings(e, { GOOGLE_CLIENT_ID: '', SEND_BATCH: null });
    e = await cfg.withConfig(deploy);
    expect(e.GOOGLE_CLIENT_ID).toBe('deploy.apps.googleusercontent.com');
    expect(e.SEND_BATCH).toBe('20');

    // Validation, and PASSCODE stays deploy-only
    await expect(saveSettings(e, { PASSCODE: 'new' })).rejects.toThrow(/deploy time/);
    await expect(saveSettings(e, { SEND_BATCH: '0' })).rejects.toThrow(/1 to 100/);
    await expect(saveSettings(e, { GMAIL_PUBSUB_TOPIC: 'my-topic' })).rejects.toThrow(/projects\//);
    await expect(saveSettings(e, { GOOGLE_CLIENT_ID: 'nope' })).rejects.toThrow(/googleusercontent/);

    // Setting the topic re-points Gmail watches right away
    vi.mocked(fetch).mockClear();
    const r = await saveSettings(e, { GMAIL_PUBSUB_TOPIC: 'projects/my-proj-1/topics/gmail-outbound' });
    expect(r.changed).toEqual(['GMAIL_PUBSUB_TOPIC']);
    const watchCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/watch'));
    expect(JSON.parse((watchCall![1] as RequestInit).body as string).topicName).toBe('projects/my-proj-1/topics/gmail-outbound');
  });

  it('push token: seeded from the old passcode-derived value, independent of later passcode changes', async () => {
    const { webhookToken, regenerateWebhookToken, hmacHex } = await import('../src/util');
    const worker = (await import('../src/index')).default;
    const cfg = await import('../src/config');
    cfg._resetConfigCache();
    const legacy = (await hmacHex('pw', 'gmail-push')).slice(0, 32);

    // Existing subscriptions keep working: first token equals what older versions derived
    expect(await webhookToken(env)).toBe(legacy);
    // Changing the passcode no longer changes it
    expect(await webhookToken({ ...env, PASSCODE: 'a-brand-new-passcode' })).toBe(legacy);

    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const push = (token: string) =>
      worker.fetch(new Request(`https://ob.test/webhooks/gmail?token=${token}`, { method: 'POST', body: '{}' }), { ...env, PASSCODE: 'a-brand-new-passcode' }, ctx);
    expect((await push(legacy)).status).toBe(204);

    // Regenerate: old URL is refused, new one accepted
    const fresh = await regenerateWebhookToken(env);
    expect(fresh).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh).not.toBe(legacy);
    expect((await push(legacy)).status).toBe(403);
    expect((await push(fresh)).status).toBe(204);
  });

  it('sender identity: mailbox defaults, per-email overrides, Reply-To, and only verified aliases', async () => {
    const mb = (await svc.listMailboxRows(env))[0];
    const aliases = await svc.refreshSendAs(env, mb);
    expect(aliases.map((a) => a.email)).toEqual(['me@ex.com', 'sales@ex.com']); // pending alias excluded

    await expect(svc.updateMailbox(env, 1, { from_email: 'pending@ex.com' })).rejects.toThrow(/Send mail as/);
    await expect(svc.updateMailbox(env, 1, { reply_to: 'not-an-email' })).rejects.toThrow(/reply_to/);
    expect(await svc.updateMailbox(env, 1, { from_email: 'sales@ex.com', reply_to: 'team@ex.com' })).toMatchObject({ from_email: 'sales@ex.com', reply_to: 'team@ex.com' });

    const decoded = () => b64urlDecodeStr(sentRaw[sentRaw.length - 1]);
    // 1. Mailbox defaults
    await svc.scheduleEmails(env, [{ mailbox: 1, to: 'a@x.com', subject: 's', body: 'b' }]);
    await processDue(env);
    expect(decoded()).toContain('From: "Me" <sales@ex.com>');
    expect(decoded()).toContain('Reply-To: team@ex.com');

    // 2. Per-email overrides win
    db.raw.exec('UPDATE mailboxes SET throttle_minutes = 1');
    const r = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'b@x.com', subject: 's', body: 'b', from_email: 'me@ex.com', from_name: 'Sam', reply_to: 'sam@other.com' }]);
    await processDue(env, [r.scheduled[0].id]);
    expect(decoded()).toContain('From: "Sam" <me@ex.com>');
    expect(decoded()).toContain('Reply-To: sam@other.com');

    // 3. Unverified From on a single email is refused
    await expect(svc.scheduleEmails(env, [{ mailbox: 1, to: 'c@x.com', subject: 's', body: 'b', from_email: 'ceo@elsewhere.com' }])).rejects.toThrow(/Send mail as/);

    // 4. Resetting defaults: From goes back to the mailbox, no Reply-To
    await svc.updateMailbox(env, 1, { from_email: '', reply_to: '' });
    const r2 = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'd@x.com', subject: 's', body: 'b' }]);
    await processDue(env, [r2.scheduled[0].id]);
    expect(decoded()).toContain('From: "Me" <me@ex.com>');
    expect(decoded()).not.toContain('Reply-To:');

    // 5. A message we sent from an alias isn't recorded as a reply
    inbox.Z1 = gmsg('Z1', 'Ex Sales <sales@ex.com>', 'following up');
    history = [{ id: '400', messagesAdded: [{ message: { id: 'Z1', threadId: 'T1', labelIds: ['INBOX'] } }] }];
    const m = (await svc.listMailboxRows(env))[0];
    m.history_id = '100';
    expect(await syncMailbox(env, m)).toEqual({ processed: 0 });
  });

  it('app name: set in Settings, shown in the app shell and sign-in page, escaped', async () => {
    const worker = (await import('../src/index')).default;
    const { saveSettings } = await import('../src/settings');
    const cfg = await import('../src/config');
    cfg._resetConfigCache();
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const get = async (path: string) => (await worker.fetch(new Request(`https://ob.test${path}`, { headers: { authorization: 'Bearer pw' } }), env, ctx)).text();

    expect(await get('/')).toContain('<title>Outbound</title>');
    await expect(saveSettings(env, { APP_NAME: '<b>x</b>' })).rejects.toThrow(/App name/);
    await saveSettings(env, { APP_NAME: 'Acme Reach & Co' });
    const page = await get('/');
    expect(page).toContain('<title>Acme Reach &amp; Co</title>');
    expect(page).toContain('<span id="appName">Acme Reach &amp; Co</span>');
    expect(page).not.toContain('{{APP_NAME}}');
    expect(await get('/login')).toContain('Acme Reach &amp; Co</div>');
    await saveSettings(env, { APP_NAME: '' });
    expect(await get('/')).toContain('<title>Outbound</title>');
  });

  it('contacts and lists: import, group, and send a template to a growing list only once per person', async () => {
    const ct = await import('../src/contacts');
    await tmpl.createTemplate(env, { template_id: 'hello-v1', subject: 'Hi {{first_name}}', body: 'Hello {{first_name}} at {{company}}' });

    // Import: email required, name optional, every other column becomes a field
    const imp = await ct.importContacts(env, {
      lists: ['Q1 Leads'],
      rows: [
        { Email: 'Ann@A.com', 'First Name': 'Ann', Company: 'A Co', Role: 'CEO' },
        { to: 'bob@b.com', name: 'Bob B', first_name: 'Bob' }, // no company
        { email: 'not-an-email', first_name: 'X' },
        { first_name: 'No email' },
        { email: 'ann@a.com', city: 'Paris' }, // same person twice in one upload: merged
      ],
    });
    expect(imp).toMatchObject({ created: 2, updated: 0, lists: [{ list: 'Q1 Leads', added: 2 }] });
    expect(imp.invalid.map((i) => i.reason)).toEqual(['invalid email', 'no email']);
    const ann = (await ct.listContacts(env, { q: 'ann@a.com' })).contacts[0];
    expect(ann).toMatchObject({ email: 'ann@a.com', name: 'Ann', fields: { first_name: 'Ann', company: 'A Co', role: 'CEO', city: 'Paris' }, lists: ['Q1 Leads'] });

    // Re-import: blanks don't erase, new values update, second list added
    await ct.importContacts(env, { lists: ['q1 leads', 'Founders'], rows: [{ email: 'ann@a.com', company: '', title: 'Founder' }] });
    const ann2 = (await ct.listContacts(env, { q: 'ann@a.com' })).contacts[0];
    expect(ann2.fields).toMatchObject({ company: 'A Co', title: 'Founder' });
    expect(ann2.lists).toEqual(['Founders', 'Q1 Leads']); // list names are case-insensitive
    expect((await ct.listLists(env)).map((l) => [l.name, l.contacts])).toEqual([['Founders', 1], ['Q1 Leads', 2]]);

    // Preview: Bob lacks {{company}}
    let pv = await ct.previewListSend(env, { lists: ['Q1 Leads'], template_id: 'hello-v1' });
    expect(pv).toMatchObject({ contacts: 2, will_send: 1, skipped: { missing_values: 1, already_received: 0, do_not_send: 0 }, coverage: { company: 1, first_name: 2 } });

    // Send: only Ann; rendered from her fields; contact id in metadata
    let r = await ct.sendToLists(env, { lists: ['Q1 Leads'], mailbox: 1, template_id: 'hello-v1', auto_schedule: true });
    expect(r).toMatchObject({ contacts: 2, scheduled: 1 });
    const e = await svc.getEmailRow(env, r.emails[0].id);
    expect(e).toMatchObject({ to_email: 'ann@a.com', subject: 'Hi Ann', body_text: 'Hello Ann at A Co', template_id: 'hello-v1' });
    expect(JSON.parse(e.metadata!)).toMatchObject({ contact_id: ann.id, company: 'A Co' });

    // Grow the list; send again: only the new person
    await ct.importContacts(env, { lists: ['Q1 Leads'], rows: [{ email: 'cy@c.com', first_name: 'Cy', company: 'C Co' }] });
    pv = await ct.previewListSend(env, { lists: ['Q1 Leads'], template_id: 'hello-v1' });
    expect(pv).toMatchObject({ contacts: 3, will_send: 1, skipped: { already_received: 1, missing_values: 1 } });
    r = await ct.sendToLists(env, { lists: ['Q1 Leads'], mailbox: 1, template_id: 'hello-v1', auto_schedule: true });
    expect(r.emails.map((x) => x.to)).toEqual(['cy@c.com']);

    // Do-not-send contacts are skipped
    await svc.dncAdd(env, ['bob@b.com'], null, 'manual');
    pv = await ct.previewListSend(env, { lists: ['Q1 Leads', 'Founders'], subject: 'Quick note', body: 'Hi {{first_name}}' });
    expect(pv).toMatchObject({ contacts: 3, will_send: 2, skipped: { do_not_send: 1 } });

    // Without a template, a message sends to everyone each time (no once-only rule)
    r = await ct.sendToLists(env, { lists: ['Founders'], mailbox: 1, subject: 'Hey {{first_name}}', body: '<p>Hi {{first_name}} & co</p>' });
    expect((await svc.getEmailRow(env, r.emails[0].id))).toMatchObject({ subject: 'Hey Ann', body_html: '<p>Hi Ann & co</p>' });

    // Membership changes and deletes
    const cy = (await ct.listContacts(env, { q: 'cy@c.com' })).contacts[0];
    expect(await ct.setContactLists(env, { ids: [cy.id], add: ['VIP'], remove: ['Q1 Leads'] })).toEqual({ added: 1, removed: 1 });
    expect((await ct.getContact(env, cy.id)).lists).toEqual(['VIP']);
    await ct.deleteList(env, 'VIP');
    expect((await ct.getContact(env, cy.id)).lists).toEqual([]); // contact kept
    expect(await ct.deleteContacts(env, [cy.id])).toEqual({ deleted: 1 });
    await expect(ct.getContact(env, cy.id)).rejects.toThrow(/not found/);
    expect((await svc.listEmails(env, { to: 'cy@c.com' })).total).toBe(1); // email history kept
  });

  it('list membership by email through the HTTP API', async () => {
    const worker = (await import('../src/index')).default;
    (await import('../src/config'))._resetConfigCache();
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const call = async (path: string, body: unknown) =>
      (await worker.fetch(new Request(`https://ob.test/api${path}`, { method: 'POST', headers: { authorization: 'Bearer pw', 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, ctx)).json() as Promise<any>;

    // Create contacts and put them on lists in one call
    expect(await call('/contacts/import', { rows: [{ email: 'a@x.com', first_name: 'A' }, { email: 'b@x.com' }], lists: ['Leads', 'Webinar'] })).toMatchObject({ created: 2, lists: [{ list: 'Leads', added: 2 }, { list: 'Webinar', added: 2 }] });

    // Existing contacts by email: add to a new list, remove from another; unknown emails reported
    const r = await call('/contacts/lists', { emails: ['A@x.com', 'b@x.com', 'nobody@x.com'], add: ['VIP'], remove: ['Webinar'] });
    expect(r).toEqual({ added: 2, removed: 2, not_found: ['nobody@x.com'] });
    const lists = await (await worker.fetch(new Request('https://ob.test/api/lists', { headers: { authorization: 'Bearer pw' } }), env, ctx)).json() as any[];
    expect(lists.map((l) => [l.name, l.contacts])).toEqual([['Leads', 2], ['VIP', 2], ['Webinar', 0]]);

    // Only unknown emails: nothing to do, not an error
    expect(await call('/contacts/lists', { emails: ['ghost@x.com'], add: ['VIP'] })).toEqual({ added: 0, removed: 0, not_found: ['ghost@x.com'] });
  });

  it('add one contact with all its attributes over the API, then update and look it up by email', async () => {
    const worker = (await import('../src/index')).default;
    (await import('../src/config'))._resetConfigCache();
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const req = (method: string, path: string, body?: unknown) =>
      worker.fetch(new Request(`https://ob.test/api${path}`, { method, headers: { authorization: 'Bearer pw', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx);

    let res = await req('POST', '/contacts', {
      email: 'Jane@Acme.com', first_name: 'Jane', last_name: 'Doe', company: 'Acme', 'Job Title': 'CTO', phone: '+1 555 0100',
      fields: { city: 'Austin', linkedin: 'https://linkedin.com/in/jane' }, lists: ['Leads', 'Founders'],
    });
    expect(res.status).toBe(201);
    let body = (await res.json()) as any;
    expect(body.contact).toMatchObject({
      email: 'jane@acme.com', name: 'Jane Doe', lists: ['Founders', 'Leads'],
      fields: { first_name: 'Jane', last_name: 'Doe', company: 'Acme', job_title: 'CTO', phone: '+1 555 0100', city: 'Austin', linkedin: 'https://linkedin.com/in/jane' },
    });

    // Update: changing only last_name keeps first_name in the full name; blanks don't erase; 200 not 201
    res = await req('POST', '/contacts', { email: 'jane@acme.com', last_name: 'Smith', company: '', title: 'CEO' });
    expect(res.status).toBe(200);
    body = (await res.json()) as any;
    expect(body).toMatchObject({ created: false, contact: { name: 'Jane Smith', fields: { company: 'Acme', title: 'CEO', first_name: 'Jane' } } });

    // Look up by exact email
    const found = (await (await req('GET', '/contacts?email=JANE@acme.com')).json()) as any;
    expect(found.contacts.map((c: any) => c.email)).toEqual(['jane@acme.com']);

    // Validation
    expect((await req('POST', '/contacts', { first_name: 'No email' })).status).toBe(400);
    expect((await req('POST', '/contacts', { email: 'nope' })).status).toBe(400);
    expect((await req('POST', '/contacts', { email: 'x@y.com', company: { nested: true } })).status).toBe(400);
  });

  it('MCP: contact, list, reply, mailbox and template management tools all work through /mcp', async () => {
    env.OPENROUTER_API_KEY = 'k';
    const worker = (await import('../src/index')).default;
    (await import('../src/config'))._resetConfigCache();
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    let rpcId = 0;
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await worker.fetch(
        new Request('https://ob.test/mcp', {
          method: 'POST',
          headers: { authorization: 'Bearer pw', 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
        }),
        env,
        ctx,
      );
      const j = (await res.json()) as any;
      if (j.result.isError) throw new Error(j.result.content[0].text);
      return j.result.structuredContent;
    };

    // tools/list advertises them
    const list = (await (await worker.fetch(new Request('https://ob.test/mcp', { method: 'POST', headers: { authorization: 'Bearer pw', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) }), env, ctx)).json()) as any;
    const names = list.result.tools.map((t: any) => t.name);
    for (const n of ['get_contact', 'update_contact', 'delete_contacts', 'save_list', 'delete_list', 'check_replies', 'redeliver_webhook', 'recategorize_reply', 'refresh_send_as', 'delete_template']) expect(names).toContain(n);
    expect(names).not.toContain('disconnect_mailbox');

    // Contacts
    await tool('save_contact', { email: 'jane@acme.com', first_name: 'Jane', last_name: 'Doe', company: 'Acme', city: 'Austin', lists: ['Leads'] });
    expect(await tool('get_contact', { email: 'JANE@acme.com' })).toMatchObject({ name: 'Jane Doe', fields: { company: 'Acme', city: 'Austin' }, lists: ['Leads'] });
    const upd = await tool('update_contact', { email: 'jane@acme.com', set: { title: 'CTO', company: 'Acme Inc' }, remove: ['city'] });
    expect(upd.fields).toEqual({ first_name: 'Jane', last_name: 'Doe', company: 'Acme Inc', title: 'CTO' });
    expect((await tool('update_contact', { email: 'jane@acme.com', fields: { only: 'this' } })).fields).toEqual({ only: 'this' });
    await expect(tool('get_contact', { email: 'ghost@x.com' })).rejects.toThrow(/No contact/);

    // Lists: create empty, rename, delete (contacts stay)
    expect(await tool('save_list', { name: 'Webinar' })).toMatchObject({ name: 'Webinar', contacts: 0 });
    expect(await tool('save_list', { name: 'webinar', rename_to: 'Webinar Nov', description: 'Signed up' })).toMatchObject({ name: 'Webinar Nov', description: 'Signed up' });
    await tool('set_contact_lists', { emails: ['jane@acme.com'], add: ['Webinar Nov'] });
    await tool('delete_list', { name: 'Webinar Nov' });
    expect((await tool('get_contact', { email: 'jane@acme.com' })).lists).toEqual(['Leads']);

    // Delete contacts by email
    expect(await tool('delete_contacts', { emails: ['jane@acme.com', 'ghost@x.com'] })).toEqual({ deleted: 1 });

    // Replies: check now, recategorize, redeliver
    await svc.scheduleEmails(env, [{ mailbox: 1, to: 'bob@acme.com', subject: 'Hello', body: 'Want a demo?' }]);
    await processDue(env);
    inbox.M1 = gmsg('M1', 'Bob <bob@acme.com>', 'Sure, we need a new website actually');
    history = [{ id: '500', messagesAdded: [{ message: { id: 'M1', threadId: 'T1', labelIds: ['INBOX'] } }] }];
    db.raw.exec("UPDATE mailboxes SET history_id = '100'");
    const chk = await tool('check_replies', { mailbox: 'me@ex.com' });
    expect(chk.new_replies).toBe(1);
    const reply = (await svc.listReplies(env, {})).replies[0];
    expect(reply.category).toBe('new_site');
    expect((await tool('recategorize_reply', { reply_id: reply.id })).reply.category).toBe('new_site');
    const before = hooks.length;
    expect(await tool('redeliver_webhook', { reply_id: reply.id })).toMatchObject({ delivered: 1, webhook_status: 'delivered' });
    expect(hooks.length).toBe(before + 1);

    // Mailbox aliases and templates
    expect((await tool('refresh_send_as', { mailbox: 'me@ex.com' })).result.map((a: any) => a.email)).toEqual(['me@ex.com', 'sales@ex.com']);
    await tool('save_template', { template_id: 'tmp-1', subject: 'S', body: 'B' });
    expect(await tool('delete_template', { template_id: 'tmp-1' })).toEqual({ deleted: 'tmp-1' });
  });

  it('API docs need sign-in; signing in returns you to them', async () => {
    const worker = (await import('../src/index')).default;
    (await import('../src/config'))._resetConfigCache();
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const get = (path: string, auth = false) => worker.fetch(new Request(`https://ob.test${path}`, { headers: auth ? { authorization: 'Bearer pw' } : {} }), env, ctx);

    const anon = await get('/api-docs');
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toBe('/login?next=%2Fapi-docs');
    expect((await get('/api-docs/openapi.json')).status).toBe(401);

    const page = await get('/api-docs', true);
    expect(await page.text()).toContain("url: '/api-docs/openapi.json'");
    const spec = (await (await get('/api-docs/openapi.json', true)).json()) as any;
    expect(spec.servers[0].url).toBe('https://ob.test/api');

    // The login form carries the return path, and a correct passcode redirects there
    expect(await (await get('/login?next=%2Fapi-docs')).text()).toContain('name="next" value="/api-docs"');
    const form = new FormData();
    form.set('passcode', 'pw');
    form.set('next', '/api-docs');
    const login = await worker.fetch(new Request('https://ob.test/login', { method: 'POST', body: form }), env, ctx);
    expect(login.headers.get('location')).toBe('/api-docs');
    const evil = new FormData();
    evil.set('passcode', 'pw');
    evil.set('next', '//evil.com');
    expect((await worker.fetch(new Request('https://ob.test/login', { method: 'POST', body: evil }), env, ctx)).headers.get('location')).toBe('/');
  });
});
