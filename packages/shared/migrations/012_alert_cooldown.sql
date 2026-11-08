-- Alert cooldown: avoid re-alerting a token within a short window, and track added_at for dead-token cleanup.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMPTZ;
