-- Scan bot watchlist. Safe to run more than once.
-- base_price_usd is the price the next alert is measured from (reset after every alert).
CREATE TABLE IF NOT EXISTS watchlist (
  telegram_id    BIGINT NOT NULL REFERENCES users(telegram_id),
  mint           TEXT NOT NULL,
  symbol         TEXT,
  base_price_usd DOUBLE PRECISION NOT NULL,
  added_price_usd DOUBLE PRECISION NOT NULL,
  alert_pct      REAL NOT NULL DEFAULT 25,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, mint)
);
