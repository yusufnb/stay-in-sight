-- Series (drip campaigns): an ordered set of template emails, sent one after another with a delay in
-- days, to everyone on the attached lists. Contacts added to a list later start at step 1; steps added
-- later reach everyone, including people who had finished.
CREATE TABLE series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  sender_id INTEGER,                   -- sends as this sender, or
  group_id INTEGER,                    -- through this mailbox group
  campaign TEXT,                       -- defaults to the series name
  stop_on_reply INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,   -- 0 = paused: nobody gets their next step
  last_run_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE series_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL,
  position INTEGER NOT NULL,           -- 1, 2, 3, … in send order
  template_id TEXT NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0, -- step 1: after joining; later steps: after the previous email went out
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_series_steps ON series_steps(series_id, position);

-- Lists whose contacts are enrolled. only_new: just contacts added to the list after it was attached.
CREATE TABLE series_lists (
  series_id INTEGER NOT NULL,
  list_id INTEGER NOT NULL,
  only_new INTEGER NOT NULL DEFAULT 0,
  attached_at INTEGER NOT NULL,
  PRIMARY KEY (series_id, list_id)
);

-- One per contact per series. waiting = their latest series email hasn't gone out yet.
CREATE TABLE series_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | stopped
  stop_reason TEXT,
  waiting INTEGER NOT NULL DEFAULT 0,
  last_email_id INTEGER,
  last_at INTEGER,                     -- when their latest step went out (or was skipped)
  enrolled_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (series_id, contact_id)
);
CREATE INDEX idx_series_enrollments_due ON series_enrollments(series_id, status, waiting);

-- Which steps each enrollment has had: scheduled (an email) or skipped (and why).
CREATE TABLE series_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL,
  step_id INTEGER NOT NULL,
  email_id INTEGER,
  outcome TEXT NOT NULL,               -- scheduled | skipped
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (enrollment_id, step_id)
);

ALTER TABLE emails ADD COLUMN series_id INTEGER;
ALTER TABLE emails ADD COLUMN series_step_id INTEGER;
CREATE INDEX idx_emails_series ON emails(series_id, series_step_id);
