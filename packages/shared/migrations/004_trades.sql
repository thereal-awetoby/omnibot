-- Every buy/sell the bot attempts. Safe to run more than once.
-- sol_lamports: SOL spent (buy) or received (sell). token_raw: tokens received (buy) or sold (sell), raw units.
-- status: pending (about to send), success, failed (did not land), unknown (sent but result not confirmed).
CREATE TABLE IF NOT EXISTS trades (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL REFERENCES users(telegram_id),
  wallet_id    INTEGER NOT NULL REFERENCES trade_wallets(id),
  side         TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  mint         TEXT NOT NULL,
  symbol       TEXT,
  decimals     SMALLINT NOT NULL,
  sol_lamports NUMERIC(40, 0) NOT NULL,
  token_raw    NUMERIC(40, 0) NOT NULL,
  slippage_bps INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'unknown')),
  signature    TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trades_user_wallet ON trades (telegram_id, wallet_id, id DESC);
