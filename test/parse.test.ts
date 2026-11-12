import { describe, expect, it } from 'vitest';
import { classify, isStop, messageText, stripQuotedHtml, stripQuotedText, parseAddress } from '../src/parse';
import { buildMime, htmlToText, injectPixel, encodeHeader, formatAddress } from '../src/mime';
import { b64urlDecodeStr, b64urlEncodeStr } from '../src/util';
import type { GmailMessage } from '../src/google';

const b64url = (s: string) => b64urlEncodeStr(s);

function msg(opts: { text?: string; html?: string; headers?: Record<string, string>; mimeType?: string }): GmailMessage {
  const parts = [];
  if (opts.text) parts.push({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { size: 1, data: b64url(opts.text) } });
  if (opts.html) parts.push({ mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }], body: { size: 1, data: b64url(opts.html) } });
  return {
    id: 'm1',
    threadId: 't1',
    payload: {
      mimeType: opts.mimeType || 'multipart/alternative',
      headers: Object.entries({ From: 'Jane <jane@acme.com>', Subject: 'Re: hello', ...opts.headers }).map(([name, value]) => ({ name, value })),
      parts,
    },
  };
}

describe('quote stripping', () => {
  it('strips Gmail "On ... wrote:" (wrapped) and > lines', () => {
    const t = 'Sounds great, Tuesday works.\n\nOn Mon, Nov 10, 2026 at 9:00 AM Bob Smith <\nbob@x.com> wrote:\n> Hi Jane,\n> want to chat?';
    expect(stripQuotedText(t)).toBe('Sounds great, Tuesday works.');
  });
  it('strips Outlook header block', () => {
    const t = 'Not interested.\n\nFrom: Bob <bob@x.com>\nSent: Monday\nTo: Jane\nSubject: hi\n\nHi Jane';
    expect(stripQuotedText(t)).toBe('Not interested.');
  });
  it('strips mobile signatures', () => {
    expect(stripQuotedText('Yes please\n\nSent from my iPhone')).toBe('Yes please');
  });
  it('strips gmail_quote html', () => {
    const h = '<div dir="ltr">Let us talk</div><br><div class="gmail_quote"><div>On Mon wrote:</div><blockquote>old</blockquote></div>';
    expect(htmlToText(stripQuotedHtml(h))).toBe('Let us talk');
  });
  it('falls back to html when there is no text part', () => {
    const m = msg({ html: '<div>Call me <b>tomorrow</b></div><div class="gmail_quote">On X wrote: blah</div>' });
    expect(messageText(m).latest).toBe('Call me tomorrow');
  });
});

describe('STOP detection', () => {
  it.each(['STOP', 'stop', 'Stop.', 'STOP please', 'Unsubscribe', 'remove me', '  stop!\n\nOn Mon wrote:'])('detects %j', (t) => {
    expect(isStop(stripQuotedText(t))).toBe(true);
  });
  it.each(['Please don\'t stop sending', 'Can we talk next week?', 'Stopping by the office tomorrow, can we meet and discuss pricing for the team?'])('ignores %j', (t) => {
    expect(isStop(t)).toBe(false);
  });
});

describe('classify', () => {
  it('detects auto replies', () => {
    expect(classify(msg({ text: 'I am away', headers: { 'Auto-Submitted': 'auto-replied' } }))).toBe('auto');
    expect(classify(msg({ text: 'I am away', headers: { Subject: 'Out of Office: hello' } }))).toBe('auto');
  });
  it('detects bounces', () => {
    expect(classify(msg({ text: 'failed', headers: { From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' } }))).toBe('bounce');
  });
  it('normal reply', () => {
    expect(classify(msg({ text: 'hi' }))).toBe('reply');
  });
});

describe('addresses', () => {
  it('parses', () => {
    expect(parseAddress('"Jane D" <Jane@Acme.com>')).toEqual({ name: 'Jane D', email: 'jane@acme.com' });
    expect(parseAddress('jane@acme.com')).toEqual({ name: null, email: 'jane@acme.com' });
  });
  it('formats and encodes non-ascii', () => {
    expect(formatAddress('a@b.com', 'Ann')).toBe('"Ann" <a@b.com>');
    expect(encodeHeader('Héllo')).toMatch(/^=\?UTF-8\?B\?/);
  });
});

describe('mime', () => {
  it('builds a multipart message with pixel', () => {
    const html = injectPixel('<p>Hi</p>', 'https://x.dev/t/abc.gif');
    const raw = b64urlDecodeStr(buildMime({ from: 'a@b.com', to: 'c@d.com', subject: 'Héllo', html, text: 'Hi', headers: { 'Message-ID': '<x@b.com>' } }));
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('Message-ID: <x@b.com>');
    const htmlPart = raw.split('text/html; charset="UTF-8"')[1].split('\r\n\r\n')[1].split('\r\n--')[0];
    expect(atob(htmlPart.replace(/\r\n/g, ''))).toContain('https://x.dev/t/abc.gif');
  });
});

import { composeRaw } from '../src/sender';
describe('composeRaw', () => {
  it('newsletter mailboxes: pixel, unsubscribe headers and from name', () => {
    const e = { id: 1, track_token: 'tok123', to_email: 'jane@acme.com', to_name: 'Jane', subject: 'Hi', body_text: 'Hello\nthere', body_html: null, from_name: null, from_email: null } as never;
    const mb = { email: 'me@example.com', name: 'Me', purpose: 'newsletter' } as never;
    const { raw, messageId } = composeRaw(e, mb, 'https://ob.example.com');
    const s = b64urlDecodeStr(raw);
    expect(messageId).toMatch(/^<tok123\..+@example\.com>$/);
    expect(s).toContain('From: "Me" <me@example.com>');
    expect(s).toContain('To: "Jane" <jane@acme.com>');
    expect(s).toContain('List-Unsubscribe: <https://ob.example.com/u/tok123>, <mailto:me@example.com?subject=STOP>');
    const parts = s.split(/--b_[^\r\n]+/);
    const html = atob(parts.find((p) => p.includes('text/html'))!.split('\r\n\r\n')[1].replace(/\r\n/g, ''));
    expect(html).toContain('Hello<br>');
    expect(html).toContain('https://ob.example.com/t/tok123.gif');
  });
});

import { matchCategory, buildPrompt, systemPrompt } from '../src/categorize';
describe('categorizer helpers', () => {
  const names = ['stop', 'new_site', 'not_now', 'other'];
  it.each([
    ['stop', 'stop'], ['STOP.', 'stop'], ['"new_site"', 'new_site'], ['New Site', 'new_site'], ['Category: not_now', 'not_now'], ['**other**', 'other'], ['banana', null],
  ])('maps %j to %j', (raw, want) => expect(matchCategory(raw, names)).toBe(want));
  it('builds a compact prompt with every category description', () => {
    const { user } = buildPrompt([{ name: 'stop', description: 'Opt out' }, { name: 'new_site', description: 'Wants a site' }], { reply: 'x'.repeat(5000), original_subject: 'Hi' });
    expect(user).toContain('- stop: Opt out');
    expect(user).toContain('- new_site: Wants a site');
    expect(user.length).toBeLessThan(2600); // long replies are clipped to keep the call cheap
  });
});

describe('categorizer system prompt', () => {
  it('explains the task and includes the outreach context when set', () => {
    const p = systemPrompt('We build websites for dentists.');
    expect(p).toContain('replies to outbound emails');
    expect(p).toContain('About us and our outreach:\nWe build websites for dentists.');
    expect(p).toContain('"stop"');
    expect(systemPrompt('')).not.toContain('About us');
    expect(buildPrompt([{ name: 'stop', description: 'x' }], { reply: 'hi' }, 'Ctx here').system).toContain('Ctx here');
  });
});
