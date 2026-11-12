-- Sender identity: per-mailbox defaults and per-email Reply-To.
ALTER TABLE mailboxes ADD COLUMN from_email TEXT;  -- default From address: the mailbox itself or a verified Gmail "Send mail as" alias
ALTER TABLE mailboxes ADD COLUMN reply_to TEXT;    -- default Reply-To (optional)
ALTER TABLE mailboxes ADD COLUMN send_as TEXT;     -- JSON [{email, name}] of verified aliases, loaded from Gmail
ALTER TABLE emails ADD COLUMN reply_to TEXT;       -- per-email Reply-To override
