import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import * as series from '../src/series';
import * as contacts from '../src/contacts';
import * as tmpl from '../src/templates';
import { processDue } from '../src/sender';
import { b64urlDecodeStr, type Env } from '../src/util';

const DAY = 86_400_000;
const MIN = 60_000;

describe('series (drip campaigns)', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let sent: { to: string; subject: string }[];
  let clock: number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock = Date.UTC(2026, 10, 2, 9, 0);
    vi.setSystemTime(clock);
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    sent = [];
    db.raw.exec(`INSERT INTO mailboxes (id, email, name, refresh_token, access_token, token_expires_at, history_id, created_at, daily_limit, throttle_minutes, purpose)
      VALUES (1, 'hello@app.com', 'App', 'rt', 'at', ${Date.UTC(2030, 0, 1)}, '1', 0, 1000, 1, 'newsletter')`);
    await svc.ensureDefaultSender(env, (await svc.listMailboxRows(env))[0]);
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/messages/send')) {
        const raw = b64urlDecodeStr(JSON.parse(init.body as string).raw);
        sent.push({ to: /^To: .*?<?([\w.+-]+@[\w.-]+)>?\r?$/m.exec(raw)![1], subject: /^Subject: (.*)\r?$/m.exec(raw)![1] });
        return Response.json({ id: `g${sent.length}`, threadId: `t${sent.length}` });
      }
      return new Response('not mocked', { status: 500 });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const advance = (ms: number) => vi.setSystemTime((clock += ms));
  /** One cron run: series, then send what's due (ignoring the throttle, like "send now"). */
  const tick = async () => {
    const r = await series.runSeries(env);
    // Auto-planning spaces emails a throttle apart; send what's planned in the next few minutes.
    const due = db.raw.prepare("SELECT id FROM emails WHERE status = 'scheduled' AND send_at <= ?").all(clock + 10 * MIN) as { id: number }[];
    if (due.length) await processDue(env, due.map((d) => d.id));
    return r;
  };
  const got = (to: string) => sent.filter((x) => x.to === to).map((x) => x.subject);
  const join = (emails: string[], list = 'New users') => contacts.importContacts(env, { rows: emails.map((email) => ({ email, first_name: email[0].toUpperCase() })), lists: [list] });

  const onboarding = (extra: Partial<series.SeriesInput> = {}) =>
    series.createSeries(env, {
      name: 'Onboarding',
      sender: 'hello',
      lists: ['New users'],
      steps: [
        { subject: 'Welcome {{first_name}}', body: 'Hi {{first_name}}', delay_days: 0 },
        { subject: 'Tip: lead forms', body: 'Forms', delay_days: 2 },
      ],
      ...extra,
    });

  it('sends each step after its delay, enrolls people who join later, and reaches everyone with steps added later', async () => {
    await join(['a@x.com', 'b@x.com']);
    const s = await onboarding();
    expect(s.steps.map((x) => [x.position, x.template_id, x.delay_days, x.day])).toEqual([[1, 'onboarding-1', 0, 0], [2, 'onboarding-2', 2, 2]]);

    expect(await tick()).toMatchObject({ enrolled: 2, scheduled: 2 });
    expect(got('a@x.com')).toEqual(['Welcome A']);
    expect(await tick()).toMatchObject({ scheduled: 0 }); // step 2 waits 2 days after step 1 went out
    const e = (await series.listEnrollments(env, 'Onboarding')).enrollments.find((x) => x.email === 'a@x.com')!;
    expect(e).toMatchObject({ state: 'in_progress', steps_done: 1, steps_total: 2, next_step: { position: 2, due_at: new Date(clock + 2 * DAY).toISOString() } });

    advance(DAY);
    await join(['c@x.com']); // joins a day later: starts at step 1
    expect(await tick()).toMatchObject({ enrolled: 1, scheduled: 1 });
    advance(DAY + MIN);
    expect(await tick()).toMatchObject({ scheduled: 2 }); // a and b get step 2; c's is a day away
    expect(got('b@x.com')).toEqual(['Welcome B', 'Tip: lead forms']);
    expect(got('c@x.com')).toEqual(['Welcome C']);
    await tick();
    expect((await series.getSeries(env, 'Onboarding')).stats).toMatchObject({ enrolled: 3, completed: 2, in_progress: 1 });

    // A step added later reaches people who had finished
    await series.addStep(env, 'Onboarding', { subject: 'Upgrade to Pro', body: 'Pro', delay_days: 1 });
    advance(DAY + MIN);
    await tick();
    expect(got('a@x.com')).toEqual(['Welcome A', 'Tip: lead forms', 'Upgrade to Pro']);
    expect(got('c@x.com')).toEqual(['Welcome C', 'Tip: lead forms']);
    advance(DAY + MIN);
    await tick();
    await tick();
    expect(got('c@x.com')).toEqual(['Welcome C', 'Tip: lead forms', 'Upgrade to Pro']);
    const final = await series.getSeries(env, 'Onboarding');
    expect(final.stats).toMatchObject({ completed: 3, in_progress: 0 });
    expect(final.steps.map((x) => x.stats.sent)).toEqual([3, 3, 3]);
    expect((await svc.listEmails(env, { series: 'Onboarding' })).total).toBe(9);
  });

  it('stops on do-not-send and bounces, skips a step someone already had, and pauses', async () => {
    await join(['a@x.com', 'b@x.com', 'c@x.com']);
    await tmpl.createTemplate(env, { template_id: 'welcome', subject: 'Welcome', body: 'Hi' });
    await svc.scheduleEmails(env, [{ mailbox: 1, to: 'c@x.com', template_id: 'welcome', subject: '', vars: {} }]); // c already has it
    await series.createSeries(env, { name: 'Onboarding', sender: 'hello', lists: ['New users'], steps: [{ template_id: 'welcome' }, { subject: 'Two', body: 'x', delay_days: 1 }] });
    await svc.dncAdd(env, ['a@x.com'], 'unsubscribed', 'test', null, 'all');

    expect(await tick()).toMatchObject({ enrolled: 3, scheduled: 1, skipped: 1, stopped: 1 });
    const st = Object.fromEntries((await series.listEnrollments(env, 'Onboarding')).enrollments.map((x) => [x.email, [x.state, x.stop_reason, x.steps_done]]));
    expect(st).toEqual({ 'a@x.com': ['stopped', 'do-not-send', 0], 'b@x.com': ['in_progress', null, 1], 'c@x.com': ['in_progress', null, 1] });

    // Paused: nobody gets their next step until it's active again
    await series.updateSeries(env, 'Onboarding', { active: false });
    advance(DAY + MIN);
    expect((await tick()).scheduled).toBe(0);
    await series.updateSeries(env, 'Onboarding', { active: true });
    await tick();
    expect(got('b@x.com')).toEqual(['Welcome', 'Two']);
    expect(got('c@x.com')).toEqual(['Welcome', 'Two']); // the first Welcome was the one sent outside the series
  });

  it('stops on reply when asked, follows list membership, and can enroll only people added later', async () => {
    await join(['a@x.com', 'b@x.com']);
    await join(['old@x.com'], 'Upgraded');
    await onboarding({ stop_on_reply: true });
    await series.createSeries(env, { name: 'Upsell', sender: 'hello', lists: [{ list: 'Upgraded', only_new: true }], steps: [{ subject: 'Get leads', body: 'x' }] });
    await tick();
    expect(got('old@x.com')).toEqual([]); // was on the list before it was attached

    db.raw.exec("UPDATE emails SET reply_count = 1 WHERE to_email = 'a@x.com'");
    await contacts.setContactLists(env, { emails: ['b@x.com'], remove: ['New users'] });
    advance(2 * DAY + MIN);
    await join(['new@x.com'], 'Upgraded');
    await tick();
    expect(got('a@x.com')).toEqual(['Welcome A']); // replied: stopped
    expect(got('b@x.com')).toEqual(['Welcome B']); // left the list: waits
    expect(got('new@x.com')).toEqual(['Get leads']);
    const st = Object.fromEntries((await series.listEnrollments(env, 'Onboarding')).enrollments.map((x) => [x.email, [x.state, x.stop_reason]]));
    expect(st).toEqual({ 'a@x.com': ['stopped', 'replied'], 'b@x.com': ['not_on_list', null] });

    await contacts.setContactLists(env, { emails: ['b@x.com'], add: ['New users'] }); // back on the list: carries on
    await tick();
    expect(got('b@x.com')).toEqual(['Welcome B', 'Tip: lead forms']);
  });

  it('manages steps: order, delays, one template per series, removal cancels unsent emails', async () => {
    await join(['a@x.com']);
    const s = await onboarding();
    await expect(series.addStep(env, s.id, { template_id: 'onboarding-1' })).rejects.toThrow(/already a step/);
    await expect(series.addStep(env, s.id, { subject: 'x' })).rejects.toThrow(/template_id, or a subject and body/);
    await expect(series.addStep(env, s.id, { subject: 'x', body: 'y', delay_days: -1 })).rejects.toThrow(/delay_days/);
    const third = (await series.addStep(env, s.id, { subject: 'Three', body: 'z', delay_days: 5, position: 1 })).steps[0];
    expect(third).toMatchObject({ position: 1, template_id: 'onboarding-3', subject: 'Three' });
    const moved = await series.updateStep(env, s.id, third.id, { position: 3, delay_days: 4 });
    expect(moved.steps.map((x) => [x.template_id, x.delay_days])).toEqual([['onboarding-1', 0], ['onboarding-2', 2], ['onboarding-3', 4]]);
    expect(moved.steps.map((x) => x.day)).toEqual([0, 2, 6]);

    // A step's email that hasn't gone out is cancelled when the step is removed; they move on
    await series.runSeries(env);
    const first = moved.steps[0];
    const r = await series.deleteStep(env, s.id, first.id);
    expect(r.steps.map((x) => x.position)).toEqual([1, 2]);
    expect((await svc.listEmails(env, { series: s.id })).emails[0]).toMatchObject({ status: 'cancelled', status_reason: 'series step removed' });
    await expect(series.createSeries(env, { name: 'No sender', lists: [] })).rejects.toThrow(/sender or a mailbox group/);
    expect(await series.deleteSeries(env, 'Onboarding')).toMatchObject({ deleted: 'Onboarding' });
  });
});
