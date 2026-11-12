-- Senders: named identities under a mailbox (From name, From address, Reply-To) with a description so
-- people and AI know when to use each. Every mailbox has exactly one default sender.
CREATE TABLE senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  key TEXT NOT NULL UNIQUE,            -- stable handle for API/MCP, e.g. "sam-sales"
  label TEXT NOT NULL,                 -- short human name, e.g. "Sam (Sales)"
  description TEXT,                    -- when to use it
  from_name TEXT,
  from_email TEXT,                     -- null = the mailbox address
  reply_to TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_senders_mailbox ON senders(mailbox_id);

ALTER TABLE emails ADD COLUMN sender_id INTEGER;
CREATE INDEX idx_emails_sender ON emails(sender_id);

-- One default sender per existing mailbox, from its current From name / address / Reply-To.
INSERT INTO senders (mailbox_id, key, label, description, from_name, from_email, reply_to, is_default, created_at, updated_at)
SELECT id,
  lower(replace(replace(replace(substr(email, 1, instr(email, '@') - 1), '.', '-'), '_', '-'), '+', '-')) || '-' || id,
  COALESCE(name, email),
  'Default sender for ' || email,
  name, from_email, reply_to, 1,
  CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM mailboxes;
