-- Reply categories, assigned by an LLM (OpenRouter). "stop" always exists and adds the sender to do-not-send.
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          -- lowercase slug, e.g. "new_site"
  description TEXT NOT NULL,          -- what the model reads to decide
  is_system INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

INSERT INTO categories (name, description, is_system, sort, created_at) VALUES
  ('stop', 'Asks to stop emailing, unsubscribe, be removed from the list, or not be contacted again. Also firm rejections like "not interested, don''t email me".', 1, 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('interested', 'Positive reply: wants to talk, book a call or demo, see pricing, or learn more.', 0, 1, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('new_site', 'Wants a new website built, a redesign, or to start a new site.', 0, 2, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('question', 'Asks a question or needs more information before deciding.', 0, 3, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('not_now', 'Not a fit right now or asks to follow up later, without asking to stop.', 0, 4, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('referral', 'Points to a different person or team to contact instead.', 0, 5, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('other', 'Anything that does not fit another category.', 0, 6, CAST(strftime('%s','now') AS INTEGER) * 1000);

ALTER TABLE replies ADD COLUMN category TEXT;
ALTER TABLE replies ADD COLUMN category_source TEXT;  -- ai | rule | manual
ALTER TABLE replies ADD COLUMN category_error TEXT;
ALTER TABLE replies ADD COLUMN category_cost REAL;    -- USD reported by OpenRouter
CREATE INDEX idx_replies_category ON replies(category);

-- Replies already recorded as STOP get the stop category.
UPDATE replies SET category = 'stop', category_source = 'rule' WHERE kind = 'stop' AND category IS NULL;
