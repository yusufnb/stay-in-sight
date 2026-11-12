import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import type { Env } from '../src/util';

describe('bulk actions on emails: a selection by ids or by filter', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let ids: { a: number[]; b: number[] };

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    db.raw.exec(`INSERT INTO mailboxes (id, email, name, refresh_token, access_token, token_expires_at, history_id, created_at) VALUES (1, 'me@ex.com', 'Me', 'rt', 'at', ${Date.now() + 3600_000}, '1', 0)`);
    await svc.ensureDefaultSender(env, (await svc.listMailboxRows(env))[0]);
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no network in this test', { status: 500 })));
    const later = Date.now() + 86_400_000;
    const mk = (campaign: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ mailbox: 1, to: `${campaign}${i}@lead.com`, subject: 'Hi', body: 'x', campaign, send_at: later + i * 60_000 }));
    const r = await svc.scheduleEmails(env, [...mk('a', 230), ...mk('b', 20)]);
    ids = { a: r.scheduled.filter((e) => e.campaign === 'a').map((e) => e.id), b: r.scheduled.filter((e) => e.campaign === 'b').map((e) => e.id) };
  });
  afterEach(() => vi.unstubAllGlobals());

  const status = (id: number) => (db.raw.prepare('SELECT status FROM emails WHERE id = ?').get(id) as { status: string }).status;
  const count = (st: string) => (db.raw.prepare('SELECT COUNT(*) AS n FROM emails WHERE status = ?').get(st) as { n: number }).n;

  it('cancels everything matching a filter across all pages, except the ones left out', async () => {
    const keep = ids.a.slice(0, 3);
    const r = await svc.cancelEmails(env, { filter: { campaign: 'a', status: 'scheduled' }, exclude_ids: keep });
    expect(r.cancelled).toBe(227);
    keep.forEach((id) => expect(status(id)).toBe('scheduled'));
    expect(status(ids.b[0])).toBe('scheduled');
    expect(count('scheduled')).toBe(23);
  });

  it('a filter on another status touches nothing; sent emails are never cancelled', async () => {
    db.raw.exec(`UPDATE emails SET status = 'sent' WHERE id = ${ids.b[0]}`);
    expect((await svc.cancelEmails(env, { filter: { status: 'sent' } })).cancelled).toBe(0);
    expect((await svc.cancelEmails(env, { filter: { campaign: 'b' } })).cancelled).toBe(19);
    expect(status(ids.b[0])).toBe('sent');
  });

  it('cancels more than 100 ids at once (D1 allows 100 values per statement)', async () => {
    expect((await svc.cancelEmails(env, { ids: ids.a.slice(0, 150) })).cancelled).toBe(150);
  });

  it('send now: the first few go straight away, the rest become due for the cron', async () => {
    const sent: number[][] = [];
    const r = await svc.sendNow(env, { filter: { q: 'a1' } }, async (x) => (sent.push(x), { sent: x.length, failed: 0, skipped: 0, deferred: 0 }));
    // a1, a10–a19, a100–a199: 111 emails
    expect(r).toMatchObject({ sent: svc.SEND_NOW_DIRECT, queued: 111 - svc.SEND_NOW_DIRECT });
    expect(sent[0]).toHaveLength(svc.SEND_NOW_DIRECT);
    const due = (db.raw.prepare('SELECT COUNT(*) AS n FROM emails WHERE status = ? AND send_at <= ?').get('scheduled', Date.now()) as { n: number }).n;
    expect(due).toBe(111);
    await expect(svc.sendNow(env, {}, async () => ({ sent: 0, failed: 0, skipped: 0, deferred: 0 }))).rejects.toThrow(/ids or filter/);
  });
});
