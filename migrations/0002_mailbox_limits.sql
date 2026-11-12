-- Per-mailbox sending limits: always set, never unlimited.
ALTER TABLE mailboxes ADD COLUMN throttle_minutes INTEGER NOT NULL DEFAULT 5;
UPDATE mailboxes SET daily_limit = 50 WHERE daily_limit IS NULL OR daily_limit <= 0;
