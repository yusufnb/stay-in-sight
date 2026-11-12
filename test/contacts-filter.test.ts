import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1 } from './d1shim';
import * as svc from '../src/service';
import * as contacts from '../src/contacts';
import type { Env } from '../src/util';

const DAY = 86_400_000;

describe('contacts: filters, sorting and acting on a whole filter', () => {
  let env: Env;
  let db: ReturnType<typeof makeD1>;
  const now = Date.UTC(2026, 10, 20, 12);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    db = makeD1();
    env = { DB: db as never, PASSCODE: 'pw', PUBLIC_URL: 'https://ob.test' };
    db.raw.exec(`INSERT INTO mailboxes (id, email, refresh_token, created_at) VALUES (1, 'me@ex.com', 'rt', 0)`);
    await contacts.importContacts(env, {
      lists: ['Leads'],
      rows: [
        { email: 'ann@acme.com', first_name: 'Ann', company: 'Acme', seats: '9' },
        { email: 'bob@beta.io', first_name: 'Bob', company: 'Beta', seats: '10' },
        { email: 'cy@acme.com', first_name: 'Cy', company: 'ACME Labs', plan: 'pro' },
        { email: 'dee@corp.com', first_name: 'Dee' },
      ],
    });
    await contacts.importContacts(env, { rows: [{ email: 'ann@acme.com' }], lists: ['Customers'] });
    // Ann: emailed 40 days ago and replied. Bob: emailed 2 days ago, opened. Cy: never. Dee: on do-not-send.
    const mail = (id: number, to: string, sentAgo: number, extra = '') =>
      db.raw.exec(`INSERT INTO emails (id, mailbox_id, to_email, subject, body_text, send_at, status, track_token, sent_at, created_at ${extra ? ', ' + extra.split('=')[0] : ''})
        VALUES (${id}, 1, '${to}', 's', 'b', ${now - sentAgo}, 'sent', 't${id}', ${now - sentAgo}, 0 ${extra ? ', ' + extra.split('=')[1] : ''})`);
    mail(1, 'ann@acme.com', 40 * DAY, 'reply_count=1');
    mail(2, 'ann@acme.com', 35 * DAY);
    mail(3, 'bob@beta.io', 2 * DAY, 'open_count=2');
    db.raw.exec(`INSERT INTO replies (email_id, mailbox_id, gmail_message_id, from_email, received_at, kind, webhook_status, created_at) VALUES (1, 1, 'r1', 'ann@acme.com', ${now - 39 * DAY}, 'reply', 'none', 0)`);
    await svc.dncAdd(env, ['dee@corp.com'], 'asked', 'test');
  });
  afterEach(() => vi.useRealTimers());

  const emails = async (f: contacts.ContactFilter & { sort?: string; dir?: string }) => (await contacts.listContacts(env, f)).contacts.map((c) => c.email.split('@')[0]);
  const r = (field: string, op: string, value?: unknown) => ({ field, op, value });

  it('filters on fields, activity, lists and do-not-send, combined with all or any', async () => {
    expect(await emails({ rules: [r('field:company', 'contains', 'acme')], sort: 'name', dir: 'asc' })).toEqual(['ann', 'cy']);
    expect(await emails({ rules: [r('field:company', 'is', 'acme')] })).toEqual(['ann']); // case-insensitive, exact
    expect(await emails({ rules: [r('field:company', 'is_empty')] })).toEqual(['dee']);
    expect(await emails({ rules: [r('field:seats', 'gt', 9)] })).toEqual(['bob']); // numeric, not text
    expect(await emails({ rules: [r('sent_count', 'is', 0)], sort: 'name', dir: 'asc' })).toEqual(['cy', 'dee']);
    expect(await emails({ rules: [r('last_sent_at', 'older_than_days', 30)] })).toEqual(['ann']);
    expect(await emails({ rules: [r('last_sent_at', 'within_days', 7)] })).toEqual(['bob']);
    expect(await emails({ rules: [r('last_sent_at', 'is_empty')], sort: 'name', dir: 'asc' })).toEqual(['cy', 'dee']);
    expect(await emails({ rules: [r('replied', 'is', true)] })).toEqual(['ann']);
    expect(await emails({ rules: [r('opened', 'is', 'true')] })).toEqual(['bob']);
    expect(await emails({ rules: [r('do_not_send', 'is', false), r('list', 'not_in', 'Customers')], sort: 'name', dir: 'asc' })).toEqual(['bob', 'cy']);
    expect(await emails({ match: 'any', rules: [r('replied', 'is', true), r('field:plan', 'is', 'pro')], sort: 'name', dir: 'asc' })).toEqual(['ann', 'cy']);
    // Rules arrive as JSON from a query string, alongside list and search
    expect(await emails({ list: 'Leads', q: 'acme', rules: JSON.stringify([r('field:plan', 'is_not_empty')]) })).toEqual(['cy']);
    // A % in a search is literal
    expect(await emails({ q: '%' })).toEqual([]);
    await expect(contacts.listContacts(env, { rules: [r('nope', 'is', 1)] })).rejects.toThrow(/unknown field/);
    await expect(contacts.listContacts(env, { rules: [r('email', 'resembles', 1)] })).rejects.toThrow(/unknown operator/);
    await expect(contacts.listContacts(env, { rules: [r('sent_count', 'gt', 'many')] })).rejects.toThrow(/whole number/);
  });

  it('sorts by any column or field, empty values last', async () => {
    expect(await emails({ sort: 'name', dir: 'desc' })).toEqual(['dee', 'cy', 'bob', 'ann']);
    expect(await emails({ sort: 'sent_count', dir: 'desc' })).toEqual(['ann', 'bob', 'dee', 'cy']);
    expect(await emails({ sort: 'last_sent_at', dir: 'desc' })).toEqual(['bob', 'ann', 'dee', 'cy']);
    expect(await emails({ sort: 'field:seats', dir: 'asc' })).toEqual(['ann', 'bob', 'cy', 'dee']); // 9 before 10; no seats last
    expect(await emails({ sort: 'field:company', dir: 'asc' })).toEqual(['ann', 'cy', 'bob', 'dee']);
    await expect(contacts.listContacts(env, { sort: 'shoe_size' })).rejects.toThrow(/Can't sort/);
  });

  it('acts on everyone matching a filter, across pages, minus exclusions; exports CSV', async () => {
    const acme = { rules: [r('field:company', 'contains', 'acme')] };
    const ids = (await contacts.listContacts(env, acme)).contacts.map((c) => c.id);
    expect(await contacts.setContactLists(env, { filter: acme, exclude_ids: [ids[0]], add: ['Acme people'] })).toMatchObject({ added: 1 });
    expect(await emails({ list: 'Acme people' })).toHaveLength(1);
    expect(await contacts.setContactLists(env, { filter: { list: 'Leads' }, remove: ['Leads'] })).toMatchObject({ removed: 4 });
    expect(await contacts.setContactLists(env, { filter: { rules: [r('email', 'is', 'nobody@x.com')] }, add: ['X'] })).toEqual({ added: 0, removed: 0 });

    const { csv, count } = await contacts.exportContacts(env, { filter: { rules: [r('sent_count', 'gt', 0)] } });
    expect(count).toBe(2);
    const [head, ...lines] = csv.trim().split('\r\n');
    expect(head).toBe('email,name,lists,company,first_name,seats,emails_sent,last_emailed,do_not_send,added');
    expect(lines.find((l) => l.startsWith('ann@'))).toMatch(/^ann@acme\.com,Ann,Acme people; Customers,Acme,Ann,9,2,/);

    expect(await contacts.deleteContacts(env, [], [], { filter: { rules: [r('do_not_send', 'is', true)] } })).toEqual({ deleted: 1 });
    expect((await contacts.listContacts(env, {})).total).toBe(3);
    expect((await contacts.contactFields(env)).map((f) => f.key)).toEqual(['company', 'first_name', 'seats', 'plan']);
  });
});
