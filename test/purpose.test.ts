import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import { processDue, sendReply } from '../src/sender';
import { recordReply } from '../src/sync';
import { b64urlDecodeStr, type Env } from '../src/util';

/** Headers, HTML and text of a raw MIME message. */
function parts(mime: string) {
  const [head] = mime.split('\r\n\r\n');
  const decode = (type: string) => {
    const p = mime.split(/--b_[^\r\n]+/).find((x) => x.includes(`Content-Type: ${type}`));
    return p ? new TextDecoder().decode(Uint8Array.from(atob(p.split('\r\n\r\n')[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0))) : '';
  };
  return { head, html: decode('text/html'), text: decode('text/plain') };
}

describe('mailbox purposes', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  let sent: { mime: string; threadId?: string }[];

  beforeEach(async () => {
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    sent = [];
    const exp = Date.now() + 3600_000;
    db.raw.exec(`INSERT INTO mailboxes (id, email, name, refresh_token, access_token, token_expires_at, history_id, created_at, throttle_minutes) VALUES
      (1, 'cold@ex.com', 'Cold', 'rt', 'at', ${exp}, '1', 0, 5),
      (2, 'news@ex.com', 'News', 'rt', 'at', ${exp}, '1', 0, 5),
      (3, 'help@ex.com', 'Help', 'rt', 'at', ${exp}, '1', 0, 5)`);
    await svc.updateMailbox(env, 2, { purpose: 'newsletter' });
    await svc.updateMailbox(env, 3, { purpose: 'conversation' });
    for (const mb of await svc.listMailboxRows(env)) await svc.ensureDefaultSender(env, mb);
    (await import('../src/config'))._resetConfigCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/messages/send')) {
        const b = JSON.parse(init.body as string);
        sent.push({ mime: b64urlDecodeStr(b.raw), threadId: b.threadId });
        return Response.json({ id: `g${sent.length}`, threadId: b.threadId || `t${sent.length}` });
      }
      return new Response('not mocked', { status: 500 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const sendOne = async (mailbox: number, to = 'jane@acme.com', extra: Partial<svc.ScheduleInput> = {}) => {
    const r = await svc.scheduleEmails(env, [{ mailbox, to, subject: 'Hello', body: 'Hi Jane,\nquick question.', ...extra }]);
    await processDue(env, [r.scheduled[0].id]);
    return { id: r.scheduled[0].id, ...parts(sent.at(-1)!.mime) };
  };

  it('builds mail by purpose: outreach looks personal, newsletters are bulk mail, conversations stay plain', async () => {
    const cold = await sendOne(1);
    expect(cold.head).not.toContain('List-Unsubscribe');
    expect(cold.head).not.toContain('Precedence');
    expect(cold.html).not.toContain('/t/');
    expect(cold.text).toContain('quick question.\n\nIf you\'d rather not hear from me, just reply "stop".');

    const news = await sendOne(2);
    expect(news.head).toMatch(/List-Unsubscribe: <https:\/\/ob\.test\/u\/[\w-]+>, <mailto:news@ex\.com\?subject=STOP>/);
    expect(news.head).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(news.head).toContain('List-Id: <mailbox-2.ex.com>');
    expect(news.head).toContain('Precedence: bulk');
    expect(news.html).toMatch(/<a href="https:\/\/ob\.test\/u\/[\w-]+" style="color:inherit">Unsubscribe<\/a>/);
    expect(news.html).toContain('/t/');
    expect(news.text).toMatch(/Unsubscribe: https:\/\/ob\.test\/u\/[\w-]+$/);

    const talk = await sendOne(3);
    expect(talk.head).not.toContain('List-Unsubscribe');
    expect(talk.html).not.toContain('/t/');
    expect(talk.text.trim()).toBe('Hi Jane,\nquick question.');

    // Overrides per mailbox; null goes back to the purpose default
    const mb = await svc.updateMailbox(env, 1, { track_opens: true, footer: '' });
    expect(mb).toMatchObject({ purpose: 'outreach', format: { track_opens: true, list_unsubscribe: false, footer: '' }, format_overrides: { track_opens: true, footer: '' } });
    const cold2 = await sendOne(1, 'bob@acme.com');
    expect(cold2.html).toContain('/t/');
    expect(cold2.text.trim()).toBe('Hi Jane,\nquick question.');
    expect((await svc.updateMailbox(env, 1, { track_opens: null, footer: null })).format).toMatchObject({ track_opens: false, footer: expect.stringContaining('reply "stop"') });
    await expect(svc.updateMailbox(env, 1, { purpose: 'spam' })).rejects.toThrow(/purpose must be/);
  });

  it('opt-outs are scoped by purpose, and an address keeps its widest scope', async () => {
    await svc.dncAdd(env, ['n@x.com'], 'unsubscribed', 'test', null, 'newsletter');
    await svc.dncAdd(env, ['m@x.com'], 'stop', 'test', null, 'marketing');
    await svc.dncAdd(env, ['a@x.com'], 'bounce', 'test', null, 'all');
    const outcome = async (mailbox: number) => {
      const r = await svc.scheduleEmails(env, ['n@x.com', 'm@x.com', 'a@x.com'].map((to) => ({ mailbox, to, subject: 's', body: 'b' })));
      return { sent: r.scheduled.map((x) => x.to), skipped: r.skipped.map((x) => x.to) };
    };
    expect(await outcome(2)).toEqual({ sent: [], skipped: ['n@x.com', 'm@x.com', 'a@x.com'] }); // newsletter
    expect(await outcome(1)).toEqual({ sent: ['n@x.com'], skipped: ['m@x.com', 'a@x.com'] }); // outreach
    expect(await outcome(3)).toEqual({ sent: ['n@x.com', 'm@x.com'], skipped: ['a@x.com'] }); // conversation

    // Narrower never replaces wider; wider replaces narrower
    await svc.dncAdd(env, ['m@x.com'], 'later', 'test', null, 'newsletter');
    await svc.dncAdd(env, ['n@x.com'], 'complaint', 'test', null, 'all');
    const scopes = Object.fromEntries((await svc.dncList(env, {})).entries.map((e) => [e.email, e.scope]));
    expect(scopes).toEqual({ 'n@x.com': 'all', 'm@x.com': 'marketing', 'a@x.com': 'all' });
    expect((await svc.dncList(env, { scope: 'marketing' })).total).toBe(1);

    // Adding an entry skips only the queued emails it blocks
    const q = await svc.scheduleEmails(env, [1, 3].map((mailbox) => ({ mailbox, to: 'd@x.com', subject: 's', body: 'b', send_at: '2099-01-01T00:00:00Z' })));
    expect(await svc.dncAdd(env, ['d@x.com'], 'stop', 'test', null, 'marketing')).toMatchObject({ added: 1, cancelled: 1 });
    const [o, c] = await Promise.all(q.scheduled.map((s) => svc.getEmailRow(env, s.id)));
    expect([o.status, c.status]).toEqual(['skipped', 'scheduled']);
  });

  it('a STOP or unsubscribe blocks according to the mailbox it came from', async () => {
    const stopFrom = async (mailbox: number, who: string) => {
      const { id } = await sendOne(mailbox, who);
      const mb = await svc.getMailbox(env, mailbox);
      await recordReply(env, mb, await svc.getEmailRow(env, id), {
        key: `k-${who}`, threadId: null, from: { email: who, name: null }, subject: 'Re: Hello', receivedAt: Date.now(), full: 'STOP', latest: 'STOP', kind: 'reply',
      });
    };
    await stopFrom(1, 'cold@acme.com');
    await stopFrom(2, 'news@acme.com');
    await stopFrom(3, 'talk@acme.com');
    const scopes = Object.fromEntries((await svc.dncList(env, {})).entries.map((e) => [e.email, e.scope]));
    expect(scopes).toEqual({ 'cold@acme.com': 'marketing', 'news@acme.com': 'newsletter', 'talk@acme.com': 'all' });

    // One-click unsubscribe from a newsletter: newsletters only
    const { id } = await sendOne(2, 'reader@acme.com');
    const token = (await svc.getEmailRow(env, id)).track_token;
    const worker = (await import('../src/index')).default;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    await worker.fetch(new Request(`https://ob.test/u/${token}`, { method: 'POST', body: 'List-Unsubscribe=One-Click' }), env, ctx);
    expect((await svc.dncList(env, { q: 'reader' })).entries[0]).toMatchObject({ scope: 'newsletter', source: 'unsubscribe' });
  });

  it('replies thread under the conversation: In-Reply-To, References, Re: subject, same Gmail thread', async () => {
    const first = await sendOne(3, 'jane@acme.com', { from_name: 'Dana at Help' });
    const original = await svc.getEmailRow(env, first.id);
    await recordReply(env, await svc.getMailbox(env, 3), original, {
      key: 'r1', threadId: original.gmail_thread_id, from: { email: 'jane@acme.com', name: 'Jane' }, subject: 'Re: Hello', receivedAt: Date.now(),
      full: 'Thanks! One more thing.', latest: 'Thanks! One more thing.', kind: 'reply', messageIdHeader: '<r1@mail.acme.com>',
    });

    const r = await sendReply(env, first.id, { body: 'Happy to help.' });
    expect(r).toMatchObject({ sent: true, email: { in_reply_to: first.id, to: 'jane@acme.com', subject: 'Re: Hello', from_name: 'Dana at Help' } });
    const m = parts(sent.at(-1)!.mime);
    expect(m.head).toContain('In-Reply-To: <r1@mail.acme.com>');
    expect(m.head).toContain(`References: ${original.message_id_header} <r1@mail.acme.com>`);
    expect(sent.at(-1)!.threadId).toBe(original.gmail_thread_id);

    // A reply to the reply carries the whole chain
    await sendReply(env, r.email!.id, { body: 'Anything else?' });
    const m2 = parts(sent.at(-1)!.mime);
    const replyRow = await svc.getEmailRow(env, r.email!.id);
    expect(m2.head).toContain(`References: ${original.message_id_header} <r1@mail.acme.com> ${replyRow.message_id_header}`);
    expect(m2.head).toContain('Subject: Re: Hello');

    // Same mailbox only; only sent emails
    await expect(svc.scheduleEmails(env, [{ in_reply_to: first.id, mailbox: 1, to: '', subject: '', body: 'x' }])).rejects.toThrow(/same mailbox/);
    const later = await svc.scheduleEmails(env, [{ mailbox: 3, to: 'x@y.com', subject: 's', body: 'b', send_at: '2099-01-01T00:00:00Z' }]);
    await expect(sendReply(env, later.scheduled[0].id, { body: 'x' })).rejects.toThrow(/hasn't been sent/);
  });

  it('cold outreach gets uneven spacing between auto-planned sends; others keep exact spacing', async () => {
    const gaps = async (mailbox: number) => {
      const p = await svc.previewPlan(env, mailbox, 6);
      const t = p.slots.map((s) => Date.parse(s));
      return t.slice(1).map((x, i) => Math.round((x - t[i]) / 1000));
    };
    const cold = await gaps(1);
    const news = await gaps(2);
    expect(new Set(news).size).toBe(1);
    expect(new Set(cold).size).toBeGreaterThan(1);
    expect(Math.min(...cold)).toBeGreaterThanOrEqual(news[0]);
    expect(Math.max(...cold)).toBeLessThanOrEqual(news[0] + 0.6 * 5 * 60);
    expect(await gaps(1)).toEqual(cold); // the preview is stable, so it matches what gets scheduled
  });
});
