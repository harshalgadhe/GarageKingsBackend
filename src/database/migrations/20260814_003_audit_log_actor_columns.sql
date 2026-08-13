-- Audit writers require these actor fields across authentication and admin flows.
-- Keep this separate from older bootstrap SQL so already-migrated databases are
-- corrected without rewriting migration history.

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS performed_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS ip_address VARCHAR(50);

