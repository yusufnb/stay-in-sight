-- Reusable email templates. template_id is the user-facing, immutable key.
CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id TEXT NOT NULL UNIQUE,  -- lowercase slug, e.g. "intro-v1"
  name TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,                -- HTML or plain text
  columns TEXT NOT NULL,             -- JSON array of CSV columns the template needs (always includes "to")
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE emails ADD COLUMN template_id TEXT;
CREATE INDEX idx_emails_template ON emails(template_id);

-- A template goes to an address at most once: while one is queued, sending, sent or bounced,
-- no second email with the same template_id can exist for that address. Cancelled/failed/skipped
-- ones don't count, so those people can be sent the template again.
CREATE UNIQUE INDEX idx_emails_template_once ON emails(template_id, to_email)
  WHERE template_id IS NOT NULL AND status IN ('scheduled', 'sending', 'sent', 'bounced');
