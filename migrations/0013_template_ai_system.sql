-- A template can replace the default AI personalization system prompt. NULL = the default.
-- The output format (skip / JSON answer) and today's date are always added after it.
ALTER TABLE templates ADD COLUMN ai_system TEXT;
