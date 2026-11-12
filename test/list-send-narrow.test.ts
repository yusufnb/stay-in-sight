import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import * as contacts from '../src/contacts';
import * as tmpl from '../src/templates';
import type { Env } from '../src/util';

describe('list sends: filter, order and limit', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    db.raw.exec(`INSERT INTO mailboxes (id, email, name, refresh_token, access_token, token_expires_at, history_id, created_at, daily_limit, throttle_minutes) VALUES
      (1, 'me@ex.com', 'Me', 'rt', 'at', ${Date.now() + 3600_000}, '1', 0, 500, 1)`);
    await svc.ensureDefaultSender(env, (await svc.listMailboxRows(env))[0]);
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no network in this test', { status: 500 })));
    // Joined in this order: a, b, c, d, e
    await contacts.importContacts(env, {
      lists: ['Leads'],
      rows: [
        { email: 'a@x.com', first_name: 'A', score: '5', plan: 'pro' },
        { email: 'b@x.com', first_name: 'B', score: '40', plan: 'free' },
        { email: 'c@x.com', first_name: 'C', score: '12', plan: 'pro' },
        { email: 'd@x.com', first_name: 'D', score: '9', plan: 'pro' },
        { email: 'e@x.com', first_name: 'E', score: '30', plan: 'free' },
      ],
    });
    await tmpl.createTemplate(env, { template_id: 'hi', subject: 'Hi {{first_name}}', body: 'x' });
  });
  afterEach(() => vi.unstubAllGlobals());

  const order = (r: { emails: { to: string }[] }) => r.emails.map((e) => e.to[0]).join('');
  const pro = { rules: [{ field: 'field:plan', op: 'is', value: 'pro' }] };

  it('sends only to contacts matching the filter, in list order by default', async () => {
    const pv = await contacts.previewListSend(env, { lists: ['Leads'], template_id: 'hi', filter: pro });
    expect(pv).toMatchObject({ contacts: 3, on_lists: 5, will_send: 3, held_back: 0 });
    expect(pv.first.map((x) => x.email)).toEqual(['a@x.com', 'c@x.com', 'd@x.com']);
    const r = await contacts.sendToLists(env, { lists: ['Leads'], sender: 'me', template_id: 'hi', filter: pro, auto_schedule: true });
    expect(r.contacts).toBe(3);
    expect(order(r)).toBe('acd');
    // Send times follow the order
    expect([...r.emails].sort((x, y) => x.send_at.localeCompare(y.send_at)).map((e) => e.to[0]).join('')).toBe('acd');
  });

  it('orders by a field (numbers by value) or newest-joined first', async () => {
    const byScore = await contacts.previewListSend(env, { lists: ['Leads'], template_id: 'hi', sort: 'field:score', dir: 'desc' });
    expect(byScore.first.map((x) => x.email[0]).join('')).toBe('becda');
    expect(byScore).not.toHaveProperty('on_lists');
    const newest = await contacts.previewListSend(env, { lists: ['Leads'], template_id: 'hi', dir: 'desc' });
    expect(newest.first.map((x) => x.email[0]).join('')).toBe('edcba');
  });

  it('a limit counts only people who can get it, and re-sending reaches the next ones', async () => {
    await svc.dncAdd(env, ['b@x.com'], null, 'test');
    const req = { lists: ['Leads'], sender: 'me', template_id: 'hi', sort: 'field:score', dir: 'desc', limit: 2, auto_schedule: true };
    const pv = await contacts.previewListSend(env, req);
    expect(pv).toMatchObject({ contacts: 5, will_send: 2, held_back: 2, skipped: { do_not_send: 1 } });

    const r1 = await contacts.sendToLists(env, req);
    expect(order(r1)).toBe('ec'); // b is on do-not-send, so the top two who can get it
    expect(r1).toMatchObject({ scheduled: 2, held_back: 2 });
    expect(r1.skipped).toEqual([{ to: 'b@x.com', reason: 'do-not-send list' }]);

    const r2 = await contacts.sendToLists(env, req);
    expect(order(r2)).toBe('da');
    expect(r2.held_back).toBe(0);
    expect(r2.skipped.filter((s) => s.reason === 'template already scheduled for this address').map((s) => s.to)).toEqual(['e@x.com', 'c@x.com']);
    expect((await contacts.previewListSend(env, req)).will_send).toBe(0);
  });

  it('a one-off message (no template) can be narrowed and limited too', async () => {
    const r = await contacts.sendToLists(env, { lists: ['Leads'], sender: 'me', subject: 'Hey {{first_name}}', body: 'x', filter: { rules: [{ field: 'field:score', op: 'gt', value: '10' }] }, sort: 'name', limit: 2, send_at: Date.now(), interval_minutes: 5 });
    expect(order(r)).toBe('bc');
    expect(r).toMatchObject({ contacts: 3, scheduled: 2, held_back: 1 });
  });

  it('rejects a bad limit or sort', async () => {
    await expect(contacts.previewListSend(env, { lists: ['Leads'], limit: -3 })).rejects.toThrow(/limit/);
    await expect(contacts.previewListSend(env, { lists: ['Leads'], sort: 'shoe_size' })).rejects.toThrow(/Can't sort/);
  });
});
