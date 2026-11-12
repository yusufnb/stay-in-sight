import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import * as contacts from '../src/contacts';
import * as series from '../src/series';
import { activity } from '../src/activity';
import { processDue } from '../src/sender';
import { recordReply } from '../src/sync';
import type { Env } from '../src/util';

describe('activity: everything that happened with one person', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let clock: number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock = Date.UTC(2026, 10, 2, 9, 0);
    vi.setSystemTime(clock);
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    const exp = Date.UTC(2030, 0, 1);
    db.raw.exec(`INSERT INTO mailboxes (id, email, name, refresh_token, access_token, token_expires_at, history_id, created_at, daily_limit, throttle_minutes, purpose) VALUES
      (1, 'sales@app.com', 'Sales', 'rt', 'at', ${exp}, '1', 0, 500, 1, 'outreach'),
      (2, 'hello@app.com', 'App', 'rt', 'at', ${exp}, '1', 0, 500, 1, 'newsletter')`);
    for (const mb of await svc.listMailboxRows(env)) await svc.ensureDefaultSender(env, mb);
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/messages/send') ? Response.json({ id: `g${Math.random()}`, threadId: 't' }) : new Response('x', { status: 500 }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const at = (ms: number) => vi.setSystemTime((clock += ms));

  it('collects emails from every mailbox and series, opens, replies, lists and do-not-send, newest first', async () => {
    const cold = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'Jane@Acme.com', to_name: 'Jane', subject: 'Quick question', body: 'Hi', campaign: 'q4' }]);
    await processDue(env, [cold.scheduled[0].id]);
    db.raw.exec(`UPDATE emails SET open_count = 2, first_opened_at = ${clock + 1000} WHERE id = ${cold.scheduled[0].id}`);
    at(3_600_000);
    const mb1 = await svc.getMailbox(env, 1);
    await recordReply(env, mb1, await svc.getEmailRow(env, cold.scheduled[0].id), {
      key: 'r1', threadId: 't', from: { email: 'jane@acme.com', name: 'Jane' }, subject: 'Re: Quick question', receivedAt: clock, full: 'Sounds good, send details', latest: 'Sounds good, send details', kind: 'reply',
    });
    at(3_600_000);
    await contacts.importContacts(env, { rows: [{ email: 'jane@acme.com', first_name: 'Jane', company: 'Acme' }], lists: ['Customers'] });
    await series.createSeries(env, { name: 'Onboarding', sender: 'hello', lists: ['Customers'], steps: [{ subject: 'Welcome', body: 'x' }, { subject: 'Tips', body: 'y', delay_days: 3 }] });
    await series.runSeries(env);
    at(60_000);
    await svc.dncAdd(env, ['jane@acme.com'], 'Unsubscribe link', 'unsubscribe', null, 'newsletter');

    const a = await activity(env, 'JANE@acme.com');
    expect(a.email).toBe('jane@acme.com');
    expect(a.contact).toMatchObject({ email: 'jane@acme.com', name: 'Jane', lists: ['Customers'], fields: { first_name: 'Jane', company: 'Acme' } });
    expect(a.events.map((e) => e.type)).toEqual(['do_not_send', 'email', 'series_enrolled', 'list_joined', 'contact_created', 'reply', 'email']);
    const [, welcome, , , , reply, first] = a.events as any[];
    expect(welcome.email).toMatchObject({ subject: 'Welcome', mailbox: 'hello@app.com', sender: 'App', series: { name: 'Onboarding', step: 1 }, campaign: 'Onboarding' });
    // The series email was queued, then skipped: the newsletter unsubscribe blocks this newsletter mailbox
    expect(welcome.email.status).toBe('skipped');
    expect(first.email).toMatchObject({ subject: 'Quick question', status: 'sent', mailbox: 'sales@app.com', campaign: 'q4', open_count: 2, reply_count: 1 });
    expect(reply.reply).toMatchObject({ from: 'jane@acme.com', text: 'Sounds good, send details', kind: 'reply', email_subject: 'Quick question' });
    expect(a.summary).toMatchObject({ emails: 2, sent: 1, opened: 1, replied: 1, replies: 1, mailboxes: ['hello@app.com', 'sales@app.com'], do_not_send: { scope: 'newsletter', source: 'unsubscribe' } });
    expect(a.series).toEqual([expect.objectContaining({ name: 'Onboarding', status: 'active', steps_done: 1, steps_total: 2 })]);

    // By contact id too
    expect((await activity(env, a.contact!.id)).email).toBe('jane@acme.com');
  });

  it('works for an address that is not a contact, and rejects bad input', async () => {
    const r = await svc.scheduleEmails(env, [{ mailbox: 1, to: 'stranger@x.com', subject: 'Hello', body: 'Hi', send_at: '2099-01-01T00:00:00Z' }]);
    const a = await activity(env, encodeURIComponent('stranger@x.com'));
    expect(a.contact).toBeNull();
    expect(a.summary).toMatchObject({ emails: 1, sent: 0, scheduled: 1, next_send_at: '2099-01-01T00:00:00.000Z' });
    expect(a.events).toEqual([expect.objectContaining({ type: 'email', email: expect.objectContaining({ id: r.scheduled[0].id, status: 'scheduled' }) })]);
    expect((await activity(env, 'nobody@x.com')).events).toEqual([]);
    await expect(activity(env, 'not-an-email')).rejects.toThrow(/Not an email address/);
    await expect(activity(env, 999)).rejects.toThrow(/Contact 999 not found/);
  });
});
