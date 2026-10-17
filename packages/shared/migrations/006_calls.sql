-- Group call tracking for the Scan bot. Safe to run more than once.
-- One row per (group, token): the FIRST person to post it there is the first caller.
CREATE TABLE IF NOT EXISTS calls (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     BIGINT NOT NULL,
  mint        TEXT NOT NULL,
  symbol      TEXT,
  caller_id   BIGINT NOT NULL REFERENCES users(telegram_id),
  caller_name TEXT,
  price_usd   DOUBLE PRECISION NOT NULL,
  mcap_usd    DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, mint)
);
CREATE INDEX IF NOT EXISTS calls_chat ON calls (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_caller ON calls (chat_id, caller_id, created_at DESC);
