-- X worker reliability: per-handle failure tracking and worker heartbeat
-- Safe to re-run: every statement is idempotent.

-- Ensure the x_feed_status table exists (the worker and ensureXTables create it,
-- but the migration must run standalone too).
CREATE TABLE IF NOT EXISTS x_feed_status (
  handle TEXT PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  fail_count INT NOT NULL DEFAULT 0,
  last_ok_at TIMESTAMPTZ
);

-- If the table already existed without these columns, add them.
ALTER TABLE x_feed_status ADD COLUMN IF NOT EXISTS fail_count INT NOT NULL DEFAULT 0;
ALTER TABLE x_feed_status ADD COLUMN IF NOT EXISTS last_ok_at TIMESTAMPTZ;

-- Backfill last_ok_at from checked_at for rows that are currently ok
UPDATE x_feed_status SET last_ok_at = checked_at WHERE ok AND last_ok_at IS NULL;

-- A single-row table the worker updates after every round so the bot knows
-- whether the worker is alive and how many X accounts are usable.
CREATE TABLE IF NOT EXISTS x_worker_heartbeat (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_round_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounts_total INT NOT NULL DEFAULT 0,
  accounts_active INT NOT NULL DEFAULT 0,
  handles_checked INT NOT NULL DEFAULT 0,
  round_ms INT,
  version TEXT
);
