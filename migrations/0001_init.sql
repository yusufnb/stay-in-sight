-- Connected mailboxes (Google OAuth)
CREATE TABLE mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,                         -- default From display name
  provider TEXT NOT NULL DEFAULT 'google',
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  token_expires_at INTEGER,          -- epoch ms
  history_id TEXT,                   -- Gmail history cursor for reply sync
  watch_expires_at INTEGER,          -- epoch ms, Gmail push watch expiry
  webhook_url TEXT,                  -- where replies are POSTed
  webhook_secret TEXT,               -- HMAC-SHA256 signing secret for webhook body
  daily_limit INTEGER NOT NULL DEFAULT 200,
  active INTEGER NOT NULL DEFAULT 1,
  last_sync_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

-- Scheduled / sent emails
CREATE TABLE emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  campaign TEXT,
  from_name TEXT,
  from_email TEXT,                   -- defaults to mailbox email (or a Gmail send-as alias)
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  body_html TEXT,
  body_text TEXT,
  send_at INTEGER NOT NULL,          -- epoch ms
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|sending|sent|failed|skipped|cancelled|bounced
  status_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,                -- when a sender picked it up
  track_token TEXT NOT NULL UNIQUE,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  message_id_header TEXT,
  sent_at INTEGER,
  open_count INTEGER NOT NULL DEFAULT 0,
  first_opened_at INTEGER,
  last_opened_at INTEGER,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at INTEGER,
  metadata TEXT,                     -- free-form JSON passed through to reply webhooks
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_emails_due ON emails(status, send_at);
CREATE INDEX idx_emails_campaign ON emails(campaign);
CREATE INDEX idx_emails_thread ON emails(mailbox_id, gmail_thread_id);
CREATE INDEX idx_emails_to ON emails(to_email);

-- Pixel hits
CREATE TABLE opens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL REFERENCES emails(id),
  opened_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_opens_email ON opens(email_id);

-- Inbound replies to our emails
CREATE TABLE replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL REFERENCES emails(id),
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  gmail_message_id TEXT NOT NULL UNIQUE,
  gmail_thread_id TEXT,
  from_email TEXT,
  from_name TEXT,
  subject TEXT,
  received_at INTEGER NOT NULL,
  text TEXT,                         -- reply with quoted history stripped
  full_text TEXT,                    -- whole body as received
  kind TEXT NOT NULL DEFAULT 'reply',-- reply|stop|auto|bounce
  webhook_status TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|failed|skipped|none
  webhook_attempts INTEGER NOT NULL DEFAULT 0,
  webhook_response TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_replies_email ON replies(email_id);
CREATE INDEX idx_replies_webhook ON replies(webhook_status);

-- Do-not-send list
CREATE TABLE dnc (
  email TEXT PRIMARY KEY,            -- lowercased
  reason TEXT,
  source TEXT,                       -- reply|unsubscribe|manual|api|mcp
  email_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
