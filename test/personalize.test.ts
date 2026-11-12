import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import * as tmpl from '../src/templates';
import * as contacts from '../src/contacts';
import { processDue } from '../src/sender';
import { parseAnswer, previewPersonalization } from '../src/personalize';
import { b64urlDecodeStr, type Env } from '../src/util';

describe('parseAnswer', () => {
  const draft = { subject: 'Hi {{first_name}}', body: 'Hello there', html: false };
  it('reads JSON, even wrapped in prose or code fences', () => {
    expect(parseAnswer('```json\n{"subject":"Hi Jane","body":"Hello Jane"}\n```', draft)).toEqual({ subject: 'Hi Jane', body: 'Hello Jane' });
    expect(parseAnswer('{"skip": true, "reason": "logged in today"}', draft)).toEqual({ skip: 'logged in today' });
  });
  it('rejects answers that would send something broken', () => {
    expect(parseAnswer('Sure! Here you go', draft)).toMatchObject({ error: expect.stringMatching(/JSON/) });
    expect(parseAnswer('{"subject":"Hi {{first_name}}","body":"x"}', draft)).toMatchObject({ error: expect.stringMatching(/placeholder/) });
    expect(parseAnswer('{"subject":"","body":"x"}', draft)).toMatchObject({ error: expect.stringMatching(/empty/) });
    expect(parseAnswer(`{"subject":"x","body":"${'y'.repeat(9000)}"}`, draft)).toMatchObject({ error: expect.stringMatching(/longer/) });
  });
});

describe('AI personalization at send time', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let sent: string[];
  let ai: { system: string; user: string; model: string }[];
  let answer: () => Response;

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test', OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'openai/gpt-6-luna' };
    sent = [];
    ai = [];
    db.raw.exec(`INSERT INTO mailboxes (id, email, name, refresh_token, access_token, token_expires_at, history_id, created_at, purpose) VALUES (1, 'me@ex.com', 'Me', 'rt', 'at', ${Date.now() + 3600_000}, '1', 0, 'conversation')`);
    await svc.ensureDefaultSender(env, (await svc.listMailboxRows(env))[0]);
    (await import('../src/config'))._resetConfigCache();
    answer = () => Response.json({ choices: [{ message: { content: '{"subject":"Welcome back, Jane","body":"Hi Jane, good to see you were in on Monday."}' } }], usage: { cost: 0.0004 } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).includes('openrouter.ai')) {
        const b = JSON.parse(init.body as string);
        ai.push({ system: b.messages[0].content, user: b.messages[1].content, model: b.model });
        return answer();
      }
      if (String(url).endsWith('/messages/send')) {
        sent.push(b64urlDecodeStr(JSON.parse(init.body as string).raw));
        return Response.json({ id: `g${sent.length}`, threadId: 't' });
      }
      return new Response('not mocked', { status: 500 });
    }));
    await contacts.importContacts(env, { rows: [{ email: 'jane.doe@acme.com', company: 'Acme', last_login: '2026-11-09' }], lists: ['Customers'] });
    await tmpl.createTemplate(env, {
      template_id: 'checkin',
      subject: 'Checking in, {{first_name}}',
      body: 'Hi {{first_name}}, how is {{company}} getting on?',
      ai_enabled: true,
      ai_prompt: 'Work out the first name from the email if missing. Mention their last login. If they logged in today, skip.',
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const queue = async (template = 'checkin') => {
    const r = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'jane.doe@acme.com', subject: '', template_id: template, vars: contacts.contactVars(db.raw.prepare('SELECT * FROM contacts').get() as never) }]);
    return r;
  };

  it('a missing variable no longer skips the contact; the AI fills it in with their current data when sending', async () => {
    const r = await queue();
    expect(r.skipped).toEqual([]);
    const queued = await svc.getEmailRow(env, r.scheduled[0].id);
    expect(queued.subject).toBe('Checking in, {{first_name}}'); // left for the AI
    expect(queued.body_text).toBe('Hi {{first_name}}, how is Acme getting on?');

    await processDue(env, [queued.id]);
    expect(ai).toHaveLength(1);
    expect(ai[0].model).toBe('openai/gpt-6-luna');
    expect(ai[0].system).toMatch(/Answer with JSON only/);
    expect(ai[0].user).toContain('Work out the first name');
    expect(ai[0].user).toContain('"last_login": "2026-11-09"');
    expect(ai[0].user).toContain('"lists": [\n  "Customers"');
    expect(ai[0].user).toContain('Hi {{first_name}}, how is Acme getting on?');
    expect(sent[0]).toContain('Subject: Welcome back, Jane');
    const e = await svc.getEmail(env, queued.id);
    expect(e).toMatchObject({ status: 'sent', subject: 'Welcome back, Jane', ai: { status: 'personalized', model: 'openai/gpt-6-luna', cost: 0.0004 } });
  });

  it('the AI can skip an email, and failures retry, then fail', async () => {
    answer = () => Response.json({ choices: [{ message: { content: '{"skip": true, "reason": "logged in today"}' } }] });
    const a = (await queue()).scheduled[0].id;
    expect(await processDue(env, [a])).toMatchObject({ skipped: 1 });
    expect(await svc.getEmailRow(env, a)).toMatchObject({ status: 'skipped', status_reason: 'AI: logged in today', ai_status: 'skipped' });
    expect(sent).toHaveLength(0);

    answer = () => Response.json({ error: { message: 'model overloaded' } }, { status: 503 });
    await tmpl.createTemplate(env, { template_id: 'checkin-2', subject: 'Hi {{first_name}}', body: 'x', ai_enabled: true, ai_prompt: 'p' });
    const b = (await queue('checkin-2')).scheduled[0].id;
    await processDue(env, [b]);
    expect(await svc.getEmailRow(env, b)).toMatchObject({ status: 'scheduled', ai_status: 'failed', status_reason: expect.stringMatching(/^retrying: AI personalization failed: OpenRouter 503/) });
    db.raw.exec(`UPDATE emails SET attempts = 2 WHERE id = ${b}`); // last try
    await processDue(env, [b]);
    expect(await svc.getEmailRow(env, b)).toMatchObject({ status: 'failed', status_reason: expect.stringMatching(/AI personalization failed/) });
    expect(sent).toHaveLength(0);
  });

  it('"send as written" falls back to the template, with leftover placeholders removed', async () => {
    await tmpl.updateTemplate(env, 'checkin', { ai_on_error: 'send' });
    answer = () => Response.json({ choices: [{ message: { content: 'no json here' } }] });
    const id = (await queue()).scheduled[0].id;
    await processDue(env, [id]);
    expect(sent[0]).toContain('Subject: Checking in, \r\n');
    expect(await svc.getEmailRow(env, id)).toMatchObject({ status: 'sent', ai_status: 'fallback', body_text: 'Hi , how is Acme getting on?' });
  });

  it('a template can replace the default system prompt; the answer format and date are always added', async () => {
    const id = (await queue()).scheduled[0].id;
    await processDue(env, [id]);
    expect(ai[0].system).toMatch(/^You personalize one outbound email/);
    expect(ai[0].system).toMatch(/Answer with JSON only: \{"subject": "...", "body": "..."\}\nToday is \d{4}-\d{2}-\d{2}\.$/);

    await tmpl.updateTemplate(env, 'checkin', { ai_system: 'You write for a playful brand. Use one emoji at most.' });
    expect((await tmpl.getTemplate(env, 'checkin')).ai.system).toBe('You write for a playful brand. Use one emoji at most.');
    await previewPersonalization(env, 'checkin', { contact: 'jane.doe@acme.com' });
    expect(ai[1].system).toMatch(/^You write for a playful brand\. Use one emoji at most\.\nIf the instructions say not to send/);
    expect(ai[1].system).not.toContain('You personalize one outbound email');
    expect(ai[1].system).toContain('Answer with JSON only');

    // An unsaved prompt can be tried, and "" goes back to the default
    await previewPersonalization(env, 'checkin', { contact: 'jane.doe@acme.com', ai_system: 'Formal tone.' });
    expect(ai[2].system).toMatch(/^Formal tone\./);
    await tmpl.updateTemplate(env, 'checkin', { ai_system: '' });
    expect((await tmpl.getTemplate(env, 'checkin')).ai.system).toBeNull();
    await previewPersonalization(env, 'checkin', { contact: 'jane.doe@acme.com' });
    expect(ai[3].system).toMatch(/^You personalize one outbound email/);
  });

  it('tests on a contact without sending, including unsaved instructions; plain templates are unchanged', async () => {
    const p = await previewPersonalization(env, 'checkin', { contact: 'jane.doe@acme.com', ai_prompt: 'Be very brief.' });
    expect(p.draft).toEqual({ subject: 'Checking in, {{first_name}}', body: 'Hi {{first_name}}, how is Acme getting on?', html: false });
    expect(p.data).toMatchObject({ email: 'jane.doe@acme.com', fields: { company: 'Acme', last_login: '2026-11-09' }, engagement: { emails_sent: 0 } });
    expect(p.result).toMatchObject({ ok: true, subject: 'Welcome back, Jane' });
    expect(ai[0].user).toContain('Be very brief.');
    expect(sent).toHaveLength(0);
    await expect(previewPersonalization(env, 'checkin', { contact: 'nobody@x.com' })).rejects.toThrow(/Contact not found/);

    // Without AI, a missing variable still skips the contact, and nothing calls the model
    await tmpl.createTemplate(env, { template_id: 'plain', subject: 'Hi {{first_name}}', body: 'x' });
    expect((await queue('plain')).skipped[0].reason).toMatch(/missing value for first_name/);
    expect((await tmpl.getTemplate(env, 'checkin')).ai).toEqual({ enabled: true, prompt: expect.stringContaining('first name'), model: null, on_error: 'retry', system: null });
    await expect(tmpl.updateTemplate(env, 'checkin', { ai_model: 'gpt 6' })).rejects.toThrow(/OpenRouter model id/);
  });
});
