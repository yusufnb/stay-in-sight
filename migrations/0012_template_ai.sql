-- AI personalization: a template can have each email rewritten by a model just before it is sent,
-- using the recipient's contact data and the template's instructions.
ALTER TABLE templates ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN ai_prompt TEXT;      -- what to change, in plain words
ALTER TABLE templates ADD COLUMN ai_model TEXT;       -- OpenRouter model; NULL = the app's AI model
ALTER TABLE templates ADD COLUMN ai_on_error TEXT NOT NULL DEFAULT 'retry'; -- retry (then fail) | send (as written)

-- What happened to each email: personalized | skipped (the model said not to send) | fallback (sent as written) | failed
ALTER TABLE emails ADD COLUMN ai_status TEXT;
ALTER TABLE emails ADD COLUMN ai_note TEXT;           -- skip reason or error
ALTER TABLE emails ADD COLUMN ai_model TEXT;
ALTER TABLE emails ADD COLUMN ai_cost REAL;           -- USD reported by OpenRouter
ALTER TABLE emails ADD COLUMN personalized_at INTEGER;
