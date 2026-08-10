ALTER TABLE users
  ADD COLUMN IF NOT EXISTS refresh_token_previous_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS refresh_token_rotated_at TIMESTAMPTZ;

