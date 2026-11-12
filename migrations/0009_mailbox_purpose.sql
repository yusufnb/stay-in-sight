-- What a mailbox is for. The purpose sets how its mail is built (tracking pixel, unsubscribe
-- header, footer, bulk headers, send spacing) and which do-not-send entries block it.
--   outreach      cold 1:1 outreach: no pixel, no List-Unsubscribe, "reply stop" footer, jittered spacing
--   newsletter    bulk mail to people who signed up: pixel, one-click unsubscribe, List-Id, footer link
--   conversation  human/agent back-and-forth: plain mail, threaded replies, only hard opt-outs block
ALTER TABLE mailboxes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'outreach';
-- Per-mailbox overrides of the purpose defaults. NULL = use the purpose default; footer '' = no footer.
ALTER TABLE mailboxes ADD COLUMN track_opens INTEGER;
ALTER TABLE mailboxes ADD COLUMN list_unsubscribe INTEGER;
ALTER TABLE mailboxes ADD COLUMN footer TEXT;

-- SES was added for mail to known users, so existing SES mailboxes start as newsletters.
UPDATE mailboxes SET purpose = 'newsletter' WHERE provider = 'ses';

-- Do-not-send scope: which purposes an entry blocks.
--   all         every mailbox (hard bounces, complaints, manual entries, and everything already on the list)
--   marketing   outreach + newsletter mailboxes (a STOP to cold outreach); conversations can still answer them
--   newsletter  newsletter mailboxes only (a newsletter unsubscribe)
ALTER TABLE dnc ADD COLUMN scope TEXT NOT NULL DEFAULT 'all';

-- Threaded replies: the email this one answers, so it gets In-Reply-To/References and lands in the same thread.
ALTER TABLE emails ADD COLUMN parent_email_id INTEGER REFERENCES emails(id);
-- The Message-ID header of each inbound reply, to thread our answers under it.
ALTER TABLE replies ADD COLUMN message_id_header TEXT;
