-- Multiplier posts reply to the message that made the call, and each group can turn them off or start them at a
-- bigger multiple. The bot also adds these on first use. Safe to run more than once.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_msg_id BIGINT;
CREATE TABLE IF NOT EXISTS call_settings (
  chat_id       BIGINT PRIMARY KEY,
  milestones_on BOOLEAN NOT NULL DEFAULT true,
  min_x         INT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
