import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import * as groups from '../src/groups';
import * as contacts from '../src/contacts';
import { processDue } from '../src/sender';
import { dailyLimitAt, warmupInfo } from '../src/warmup';
import type { Env } from '../src/util';

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('warm-up', () => {
  it('ramps the daily limit from start by step each day, up to the daily limit', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const mb = { daily_limit: 20, warmup_enabled: 1, warmup_start: 5, warmup_step: 3, warmup_started_at: t0 };
    expect([0, 1, 2, 4, 5, 9].map((d) => dailyLimitAt(mb, t0 + d * DAY + HOUR))).toEqual([5, 8, 11, 17, 20, 20]);
    expect(dailyLimitAt({ ...mb, warmup_enabled: 0 }, t0)).toBe(20);
    expect(warmupInfo(mb, t0 + 2 * DAY)).toMatchObject({ enabled: true, day: 3, today_limit: 11, target: 20, complete: false, completes_at: new Date(t0 + 5 * DAY).toISOString() });
    expect(warmupInfo(mb, t0 + 6 * DAY)).toMatchObject({ day: 7, today_limit: 20, complete: true });
  });
});

describe('mailbox groups', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let sent: string[];

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    sent = [];
    const exp = Date.now() + 3600_000;
    db.raw.exec(`INSERT INTO mailboxes (id, email, name, refresh_token, access_token, token_expires_at, history_id, created_at, daily_limit, throttle_minutes) VALUES
      (1, 'a@cold.com', 'Ann', 'rt', 'at', ${exp}, '1', 0, 10, 5),
      (2, 'b@cold.com', 'Ben', 'rt', 'at', ${exp}, '1', 0, 10, 5),
      (3, 'c@cold.com', 'Cal', 'rt', 'at', ${exp}, '1', 0, 10, 5)`);
    for (const mb of await svc.listMailboxRows(env)) await svc.ensureDefaultSender(env, mb);
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/messages/send')) return sent.push(url), Response.json({ id: `g${sent.length}`, threadId: `t${sent.length}` });
      return new Response('not mocked', { status: 500 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const emails = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ group: 'Cold team', to: `${prefix}${i}@lead.com`, subject: 'Hi', body: 'Hello' }));
  const rows = () => db.raw.prepare('SELECT mailbox_id, send_at, group_id, from_email, from_name, sender_id FROM emails ORDER BY send_at').all() as { mailbox_id: number; send_at: number; group_id: number; from_email: string | null; from_name: string | null; sender_id: number }[];

  it('turning warm-up on starts day 1; sending holds at the warm-up limit', async () => {
    const mb = await svc.updateMailbox(env, 1, { warmup: true, warmup_start: 2, warmup_step: 2 });
    expect(mb.warmup).toMatchObject({ enabled: true, day: 1, today_limit: 2, target: 10 });
    expect(mb.today_limit).toBe(2);
    const r = await svc.scheduleEmails(env, [0, 1, 2, 3].map((i) => ({ mailbox: 1, to: `x${i}@y.com`, subject: 's', body: 'b' })));
    const res = await processDue(env, r.scheduled.map((s) => s.id));
    expect(res).toMatchObject({ sent: 2, deferred: 2 });
    expect((await svc.getEmailRow(env, r.scheduled[2].id)).status_reason).toBe('waiting: warm-up limit of 2 today');
    expect((await svc.updateMailbox(env, 1, { warmup: false })).warmup.enabled).toBe(false);
    await expect(svc.updateMailbox(env, 1, { warmup_step: 0 })).rejects.toThrow(/warmup_step/);
  });

  it('plans a warming-up mailbox within its growing limit in every 24 hours', async () => {
    await svc.updateMailbox(env, 1, { warmup: true, warmup_start: 2, warmup_step: 2, throttle_minutes: 1 });
    const mb = await svc.getMailbox(env, 1);
    const p = await svc.previewPlan(env, 1, 20);
    const t = p.slots.map((s) => Date.parse(s));
    expect(t.filter((x) => x < t[0] + DAY).length).toBe(2);
    for (const s of t) expect(t.filter((x) => x > s - DAY && x <= s).length).toBeLessThanOrEqual(dailyLimitAt(mb, s));
  });

  it('spreads a send across the group by each mailbox’s limits and warm-up', async () => {
    const g = await groups.createGroup(env, { name: 'Cold team', description: 'Cold outreach', mailboxes: ['a@cold.com', 2, 'c@cold.com'] });
    await svc.updateMailbox(env, 3, { warmup: true, warmup_start: 2, warmup_step: 1 });
    expect((await groups.getGroup(env, 'cold team')).capacity_today).toBe(22);

    const preview = await svc.previewGroupPlan(env, g.id, 30);
    const r = await svc.scheduleEmails(env, emails(30));
    expect(r.scheduled).toHaveLength(30);
    expect((r as any).plan[0]).toMatchObject({ group: 'Cold team', count: 30 });
    const all = rows();
    const start = all[0].send_at;
    const firstDay = (id: number) => all.filter((e) => e.mailbox_id === id && e.send_at < start + DAY).length;
    expect([firstDay(1), firstDay(2), firstDay(3)]).toEqual([10, 10, 2]);
    // Throttle holds per mailbox, and the counts match the preview
    for (const id of [1, 2, 3]) {
      const ts = all.filter((e) => e.mailbox_id === id).map((e) => e.send_at);
      ts.slice(1).forEach((x, i) => expect(x - ts[i]).toBeGreaterThanOrEqual(5 * 60_000));
      expect(ts.length).toBe(preview.mailboxes.find((m) => m.mailbox === `${'abc'[id - 1]}@cold.com`)!.count);
    }
    // Each email goes out as its mailbox's default sender, tagged with the group
    const a = all.find((e) => e.mailbox_id === 1)!;
    expect(a).toMatchObject({ group_id: g.id, from_name: 'Ann', sender_id: (await svc.listMailboxes(env)).find((m) => m.id === 1)!.senders[0].id });
    expect((await svc.listEmails(env, { group: 'Cold team' })).total).toBe(30);
  });

  it('keeps a recipient on the mailbox they already heard from, skips paused mailboxes, and checks input', async () => {
    await groups.createGroup(env, { name: 'Cold team', mailboxes: [1, 2, 3] });
    await svc.scheduleEmails(env, [{ mailbox: 2, to: 'known@lead.com', subject: 'first', body: 'x' }]);
    await svc.updateMailbox(env, 1, { active: false });
    const r = await svc.scheduleEmails(env, [{ group: 'Cold team', to: 'known@lead.com', subject: 'follow-up', body: 'x' }, ...emails(6)]);
    const placed = await Promise.all(r.scheduled.map((s) => svc.getEmailRow(env, s.id)));
    expect(placed[0].mailbox_id).toBe(2);
    expect(placed.some((e) => e.mailbox_id === 1)).toBe(false);

    await expect(svc.scheduleEmails(env, [{ group: 'Cold team', sender: 'ann-1', to: 'x@y.com', subject: 's', body: 'b' }])).rejects.toThrow(/not both/);
    await expect(svc.scheduleEmails(env, [{ group: 'Cold team', from_email: 'a@cold.com', to: 'x@y.com', subject: 's', body: 'b' }])).rejects.toThrow(/from_email/);
    await svc.updateMailbox(env, 2, { active: false });
    await svc.updateMailbox(env, 3, { active: false });
    await expect(svc.scheduleEmails(env, emails(1))).rejects.toThrow(/no active, connected mailboxes/);
  });

  it('list sends go through a group; groups can be renamed, re-membered and deleted', async () => {
    const g = await groups.createGroup(env, { name: 'Cold team', mailboxes: [1, 2] });
    await contacts.importContacts(env, { rows: Array.from({ length: 8 }, (_, i) => ({ email: `c${i}@lead.com`, first_name: `C${i}` })), lists: ['Leads'] });
    const r = await contacts.sendToLists(env, { lists: ['Leads'], group: 'Cold team', subject: 'Hi {{first_name}}', body: 'Hello' });
    expect(r.scheduled).toBe(8);
    expect(new Set(rows().map((e) => e.mailbox_id))).toEqual(new Set([1, 2]));

    await expect(groups.createGroup(env, { name: 'cold TEAM' })).rejects.toThrow(/already exists/);
    const other = await groups.createGroup(env, { name: 'Warm', mailboxes: [2] }); // moves b@ out of Cold team
    expect((await groups.getGroup(env, g.id)).mailboxes.map((m) => m.email)).toEqual(['a@cold.com']);
    expect((await svc.listMailboxes(env)).find((m) => m.id === 2)!.group).toEqual({ id: other.id, name: 'Warm' });
    await groups.updateGroup(env, g.id, { name: 'Cold A' });
    expect(await groups.deleteGroup(env, 'Cold A')).toEqual({ deleted: 'Cold A' });
    expect((await svc.getMailbox(env, 1)).group_id).toBeNull();
    expect((await groups.listGroups(env)).map((x) => x.name)).toEqual(['Warm']);
  });
});
