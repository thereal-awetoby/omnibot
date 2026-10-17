CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  username    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trade and Launch wallets are intentionally separate tables.
CREATE TABLE IF NOT EXISTS trade_wallets (
  id               SERIAL PRIMARY KEY,
  telegram_id      BIGINT NOT NULL UNIQUE REFERENCES users(telegram_id),
  public_key       TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('created', 'imported')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS launch_wallets (
  id               SERIAL PRIMARY KEY,
  telegram_id      BIGINT NOT NULL UNIQUE REFERENCES users(telegram_id),
  public_key       TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('created', 'imported')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
