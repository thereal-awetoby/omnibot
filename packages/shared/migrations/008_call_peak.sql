-- The highest price seen for a call after it was made, for the "how high did it go" card. Safe to run more than once.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS peak_price_usd DOUBLE PRECISION;
