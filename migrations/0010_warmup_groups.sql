-- Warm-up: a mailbox's daily limit starts low and grows each day until it reaches daily_limit.
-- Today's limit = min(daily_limit, warmup_start + warmup_step * days since warmup_started_at).
ALTER TABLE mailboxes ADD COLUMN warmup_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mailboxes ADD COLUMN warmup_start INTEGER NOT NULL DEFAULT 5;
ALTER TABLE mailboxes ADD COLUMN warmup_step INTEGER NOT NULL DEFAULT 3;
ALTER TABLE mailboxes ADD COLUMN warmup_started_at INTEGER;

-- Mailbox groups: several mailboxes that send as one. A send to a group is spread across its
-- mailboxes by each one's limits and warm-up. A mailbox is in at most one group.
CREATE TABLE mailbox_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE mailboxes ADD COLUMN group_id INTEGER REFERENCES mailbox_groups(id);
-- The group an email was sent through (its mailbox is the member it was assigned to).
ALTER TABLE emails ADD COLUMN group_id INTEGER;
CREATE INDEX idx_emails_group ON emails(group_id);
