import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import * as contacts from '../src/contacts';
import * as tmpl from '../src/templates';
import * as groups from '../src/groups';
import * as series from '../src/series';
import type { Env } from '../src/util';

/**
 * Cloudflare allows at most 1000 calls to D1 (and other bindings) in one Worker invocation. Bulk paths
 * must stay well under that however many contacts there are: no database call per recipient.
 */
const N = 2500;
const BUDGET = 300;

describe(`bulk paths stay under the per-invocation call limit (${N} contacts)`, () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    const exp = Date.now() + 3600_000;
    db.raw.exec(`INSERT INTO mailboxes (id, email, name, refresh_token, access_token, token_expires_at, history_id, created_at, daily_limit, throttle_minutes, send_as) VALUES
      (1, 'me@ex.com', 'Me', 'rt', 'at', ${exp}, '1', 0, 2000, 1, '[{"email":"me@ex.com","name":"Me"},{"email":"sales@ex.com","name":"Sales"}]'),
      (2, 'two@ex.com', 'Two', 'rt', 'at', ${exp}, '1', 0, 2000, 1, '[]')`);
    for (const mb of await svc.listMailboxRows(env)) await svc.ensureDefaultSender(env, mb);
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no network in this test', { status: 500 })));
    await contacts.importContacts(env, { lists: ['Everyone'], rows: Array.from({ length: N }, (_, i) => ({ email: `p${i}@lead.com`, first_name: `P${i}`, company: i % 2 ? 'Acme' : 'Beta' })) });
  });
  afterEach(() => vi.unstubAllGlobals());

  const calls = async (fn: () => Promise<unknown>) => {
    const before = db.counter.calls;
    await fn();
    return db.counter.calls - before;
  };

  it('sending to a whole list, the way the Send page does (sender and mailbox, a From override)', async () => {
    let r: Awaited<ReturnType<typeof contacts.sendToLists>> | undefined;
    const used = await calls(async () => {
      r = await contacts.sendToLists(env, { lists: ['Everyone'], sender: 'me', mailbox: 1, from_email: 'sales@ex.com', subject: 'Hi {{first_name}}', body: 'Hello', auto_schedule: true });
    });
    expect(r!.scheduled).toBe(N);
    expect(used).toBeLessThan(BUDGET);
  });

  it('a template send, a group send, the list preview, and a series run', async () => {
    await tmpl.createTemplate(env, { template_id: 'intro', subject: 'Hi {{first_name}}', body: 'About {{company}}' });
    expect(await calls(() => contacts.previewListSend(env, { lists: ['Everyone'], template_id: 'intro', sender: 'me' }))).toBeLessThan(BUDGET);
    expect(await calls(() => contacts.sendToLists(env, { lists: ['Everyone'], sender: 'me', template_id: 'intro', auto_schedule: true }))).toBeLessThan(BUDGET);

    await groups.createGroup(env, { name: 'Team', mailboxes: [1, 2] });
    await tmpl.createTemplate(env, { template_id: 'intro-2', subject: 'Hi', body: 'x' });
    expect(await calls(() => contacts.sendToLists(env, { lists: ['Everyone'], group: 'Team', template_id: 'intro-2' }))).toBeLessThan(BUDGET);

    await series.createSeries(env, { name: 'Drip', sender: 'two', lists: ['Everyone'], steps: [{ subject: 'One', body: 'x' }] });
    expect(await calls(() => series.runSeries(env))).toBeLessThan(BUDGET);
  });

  it('a filtered, sorted, limited list send and its preview', async () => {
    await tmpl.createTemplate(env, { template_id: 'acme', subject: 'Hi {{first_name}}', body: 'x' });
    const req = { lists: ['Everyone'], sender: 'me', template_id: 'acme', filter: { rules: [{ field: 'field:company', op: 'is', value: 'Acme' }] }, sort: 'field:first_name', limit: 1000, auto_schedule: true };
    expect(await calls(() => contacts.previewListSend(env, req))).toBeLessThan(BUDGET);
    let r: Awaited<ReturnType<typeof contacts.sendToLists>> | undefined;
    expect(await calls(async () => void (r = await contacts.sendToLists(env, req)))).toBeLessThan(BUDGET);
    expect(r).toMatchObject({ contacts: N / 2, scheduled: 1000, held_back: N / 2 - 1000 });
  });

  it('cancelling every scheduled email matching a filter', async () => {
    await contacts.sendToLists(env, { lists: ['Everyone'], sender: 'me', subject: 'Hi', body: 'x', send_at: Date.now() + 86_400_000, interval_minutes: 1 });
    let r: { cancelled: number } | undefined;
    expect(await calls(async () => void (r = await svc.cancelEmails(env, { filter: { status: 'scheduled', q: 'lead.com' } })))).toBeLessThan(BUDGET);
    expect(r!.cancelled).toBe(N);
  });

  it('contact bulk actions on everyone matching a filter, and export', async () => {
    const acme = { rules: [{ field: 'field:company', op: 'is', value: 'Acme' }] };
    expect(await calls(() => contacts.listContacts(env, { ...acme, sort: 'name' }))).toBeLessThan(BUDGET);
    expect(await calls(() => contacts.setContactLists(env, { filter: acme, add: ['Acme people'] }))).toBeLessThan(BUDGET);
    expect(await calls(() => contacts.exportContacts(env, { filter: {} }))).toBeLessThan(BUDGET);
    expect(await calls(() => contacts.deleteContacts(env, [], [], { filter: acme }))).toBeLessThan(BUDGET);
  });
});
