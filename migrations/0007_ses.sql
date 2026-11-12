-- AWS SES mailboxes (provider = 'ses'). Replies come back through Cloudflare Email Routing to
-- reply+<track_token>@<reply_domain>; bounces and complaints through SNS to /webhooks/ses.
ALTER TABLE mailboxes ADD COLUMN ses_region TEXT;
ALTER TABLE mailboxes ADD COLUMN ses_access_key_id TEXT;
ALTER TABLE mailboxes ADD COLUMN ses_secret_access_key TEXT;
ALTER TABLE mailboxes ADD COLUMN ses_configuration_set TEXT;
ALTER TABLE mailboxes ADD COLUMN ses_status TEXT;     -- JSON from the last account check (sandbox, quota)
ALTER TABLE mailboxes ADD COLUMN reply_domain TEXT;   -- e.g. reply.example.com, routed to this Worker
ALTER TABLE mailboxes ADD COLUMN forward_to TEXT;     -- optional: also forward each reply to this inbox
ALTER TABLE emails ADD COLUMN ses_message_id TEXT;    -- SES MessageId, to match bounce/complaint events
CREATE INDEX idx_emails_ses_message ON emails(ses_message_id);
