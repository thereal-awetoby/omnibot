-- Allow several trade wallets per user, with one "active" wallet.
-- Safe to run more than once.
ALTER TABLE trade_wallets DROP CONSTRAINT IF EXISTS trade_wallets_telegram_id_key;
ALTER TABLE trade_wallets ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE trade_wallets ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false;

-- Existing single wallets become "Wallet 1" and active (only for users with no active wallet yet).
UPDATE trade_wallets SET label = 'Wallet 1' WHERE label IS NULL;
UPDATE trade_wallets SET is_active = true
WHERE id IN (
  SELECT DISTINCT ON (w.telegram_id) w.id
  FROM trade_wallets w
  WHERE NOT EXISTS (
    SELECT 1 FROM trade_wallets a WHERE a.telegram_id = w.telegram_id AND a.is_active
  )
  ORDER BY w.telegram_id, w.id
);

CREATE UNIQUE INDEX IF NOT EXISTS trade_wallets_one_active ON trade_wallets (telegram_id) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS trade_wallets_user_pubkey ON trade_wallets (telegram_id, public_key);
