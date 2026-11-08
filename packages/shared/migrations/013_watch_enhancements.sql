-- P2: enhanced watchlist — track curve state for graduation alerts and volume baseline for spike detection.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS on_curve BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS curve_alerted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS vol_baseline DOUBLE PRECISION;
