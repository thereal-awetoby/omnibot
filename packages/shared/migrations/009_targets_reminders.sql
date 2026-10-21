-- Price targets (alert me when a token reaches 3x, 4x, -50%...) and reminders. Safe to run more than once.
CREATE TABLE IF NOT EXISTS price_targets (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  base_price_usd DOUBLE PRECISION NOT NULL,
  mult DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at TIMESTAMPTZ,
  UNIQUE (telegram_id, mint, mult)
);
CREATE INDEX IF NOT EXISTS price_targets_active ON price_targets (fired_at) WHERE fired_at IS NULL;

CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  chat_id BIGINT NOT NULL,
  fire_at TIMESTAMPTZ NOT NULL,
  body TEXT NOT NULL,
  who TEXT,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (fire_at) WHERE done = false;
