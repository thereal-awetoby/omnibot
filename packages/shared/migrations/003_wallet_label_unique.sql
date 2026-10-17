-- Wallet names must be unique per user (case-insensitive). Safe to run more than once.
CREATE UNIQUE INDEX IF NOT EXISTS trade_wallets_user_label ON trade_wallets (telegram_id, lower(label));
