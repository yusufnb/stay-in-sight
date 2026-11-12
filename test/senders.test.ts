import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import * as senders from '../src/senders';
import { processDue } from '../src/sender';
import { b64urlDecodeStr, type Env } from '../src/util';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('senders', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let sent: string[];

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    sent = [];
    db.raw.exec(`INSERT INTO mailboxes (email, name, refresh_token, access_token, token_expires_at, history_id, created_at, send_as)
      VALUES ('me@ex.com', 'Me', 'rt', 'at', ${Date.now() + 3600_000}, '1', 0, '[{"email":"me@ex.com","name":"Me"},{"email":"sales@ex.com","name":"Sales"},{"email":"support@ex.com","name":"Support"}]')`);
    await svc.ensureDefaultSender(env, (await svc.listMailboxRows(env))[0]);
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/messages/send')) {
        sent.push(b64urlDecodeStr(JSON.parse(init.body as string).raw));
        return Response.json({ id: `g${sent.length}`, threadId: `t${sent.length}` });
      }
      return new Response('not mocked', { status: 500 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('every mailbox has a default sender; senders validate their From address', async () => {
    const list = await senders.listSenders(env);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'me', label: 'Me', is_default: true, from_email: 'me@ex.com', mailbox: 'me@ex.com' });

    const sam = await senders.createSender(env, { mailbox: 'me@ex.com', label: 'Sam (Sales)', description: 'Follow-ups on pricing and demos', from_name: 'Sam from Ex', from_email: 'sales@ex.com', reply_to: 'deals@ex.com' });
    expect(sam).toMatchObject({ key: 'sam-sales', is_default: false, from_email: 'sales@ex.com', reply_to: 'deals@ex.com' });
    await expect(senders.createSender(env, { mailbox: 1, label: 'Bad', from_email: 'ceo@other.com' })).rejects.toThrow(/Send mail as/);
    await expect(senders.createSender(env, { mailbox: 1, label: 'Bad', reply_to: 'nope' })).rejects.toThrow(/reply_to/);
    await expect(senders.createSender(env, { mailbox: 1, label: 'Dup', key: 'sam-sales' })).rejects.toThrow(/already used/);
    expect((await senders.createSender(env, { mailbox: 1, label: 'Sam (Sales)' })).key).toBe('sam-sales-2');

    // Default switching; the default can't be deleted
    await expect(senders.deleteSender(env, 'me')).rejects.toThrow(/default/);
    await senders.updateSender(env, 'sam-sales', { is_default: true });
    expect((await senders.listSenders(env)).filter((s) => s.is_default).map((s) => s.key)).toEqual(['sam-sales']);
    expect(await senders.deleteSender(env, 'me')).toEqual({ deleted: 'me' });
  });

  it('scheduling by sender fills From name, address and Reply-To; anything given overrides it', async () => {
    await senders.createSender(env, { mailbox: 1, label: 'Support', key: 'support', description: 'Help with an existing account', from_name: 'Ex Support', from_email: 'support@ex.com', reply_to: 'help@ex.com' });

    const r = await svc.scheduleEmails(env, [
      { sender: 'support', to: 'a@x.com', subject: 's', body: 'b' },
      { sender: 'support', to: 'b@x.com', subject: 's', body: 'b', from_name: 'Dana at Ex', reply_to: 'dana@ex.com' },
      { mailbox: 'me@ex.com', to: 'c@x.com', subject: 's', body: 'b' }, // no sender → mailbox default
    ]);
    const [a, b, c] = await Promise.all(r.scheduled.map((x) => svc.getEmailRow(env, x.id)));
    const support = await senders.getSender(env, 'support');
    expect(a).toMatchObject({ sender_id: support.id, from_name: 'Ex Support', from_email: 'support@ex.com', reply_to: 'help@ex.com' });
    expect(b).toMatchObject({ sender_id: support.id, from_name: 'Dana at Ex', from_email: 'support@ex.com', reply_to: 'dana@ex.com' });
    expect(c).toMatchObject({ sender_id: (await senders.getSender(env, 'me')).id, from_name: 'Me' });

    // Wrong mailbox for the sender, and unknown senders
    db.raw.exec("INSERT INTO mailboxes (email, refresh_token, created_at) VALUES ('other@ex.com', 'rt', 0)");
    await expect(svc.scheduleEmails(env, [{ sender: 'support', mailbox: 'other@ex.com', to: 'd@x.com', subject: 's', body: 'b' }])).rejects.toThrow(/belongs to me@ex.com/);
    await expect(svc.scheduleEmails(env, [{ sender: 'nobody', to: 'd@x.com', subject: 's', body: 'b' }])).rejects.toThrow(/Sender not found/);

    // What's scheduled is what goes out, even if the sender changes later
    await senders.updateSender(env, 'support', { from_name: 'Renamed' });
    await processDue(env, [a.id]);
    expect(sent[0]).toContain('From: "Ex Support" <support@ex.com>');
    expect(sent[0]).toContain('Reply-To: help@ex.com');

    expect((await svc.listEmails(env, { sender: 'support' })).total).toBe(2);
    expect((await senders.getSender(env, 'support')).stats).toMatchObject({ sent: 1, scheduled: 1 });
  });

  it('MCP send_email sends immediately as a sender; list_senders exposes descriptions', async () => {
    await senders.createSender(env, { mailbox: 1, label: 'Sam (Sales)', key: 'sam', description: 'Pricing and demo follow-ups', from_name: 'Sam', from_email: 'sales@ex.com' });
    const worker = (await import('../src/index')).default;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await worker.fetch(new Request('https://ob.test/mcp', { method: 'POST', headers: { authorization: 'Bearer pw', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, ctx);
      const j = (await res.json()) as any;
      if (j.result.isError) throw new Error(j.result.content[0].text);
      return j.result.structuredContent;
    };
    const ls = await call('list_senders', {});
    expect(ls.result.find((s: any) => s.key === 'sam')).toMatchObject({ description: 'Pricing and demo follow-ups', from_email: 'sales@ex.com' });

    const r = await call('send_email', { sender: 'sam', to: 'lead@acme.com', subject: 'Pricing', body: 'Hi, here are the numbers.' });
    expect(r).toMatchObject({ sent: true, email: { to: 'lead@acme.com', from_email: 'sales@ex.com', from_name: 'Sam', status: 'sent' } });
    expect(sent[0]).toContain('From: "Sam" <sales@ex.com>');

    const later = await call('send_email', { sender: 'sam', to: 'b@acme.com', subject: 'Later', body: 'x', send_at: '2099-01-01T00:00:00Z' });
    expect(later).toMatchObject({ sent: false, scheduled: { to: 'b@acme.com' } });
    await expect(call('send_email', { sender: 'nope', to: 'x@y.com', subject: 's', body: 'b' })).rejects.toThrow(/Sender not found/);
  });

  it('the migration gives existing mailboxes a default sender from their current settings', () => {
    const raw = new DatabaseSync(':memory:');
    const dir = new URL('../migrations/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files.filter((f) => f < '0008')) raw.exec(readFileSync(new URL(f, dir), 'utf8'));
    raw.exec("INSERT INTO mailboxes (email, name, refresh_token, created_at, from_email, reply_to) VALUES ('jo.smith+out@ex.com', 'Jo', 'rt', 0, 'jo@ex.com', 'team@ex.com')");
    raw.exec(readFileSync(new URL(files.find((f) => f.startsWith('0008'))!, dir), 'utf8'));
    expect(raw.prepare('SELECT key, label, from_name, from_email, reply_to, is_default FROM senders').all()).toEqual([
      { key: 'jo-smith-out-1', label: 'Jo', from_name: 'Jo', from_email: 'jo@ex.com', reply_to: 'team@ex.com', is_default: 1 },
    ]);
  });
});
