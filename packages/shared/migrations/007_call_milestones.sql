-- Remembers the biggest multiple already announced for a call, so each one is posted once. Safe to run more than once.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS last_x INT NOT NULL DEFAULT 1;
