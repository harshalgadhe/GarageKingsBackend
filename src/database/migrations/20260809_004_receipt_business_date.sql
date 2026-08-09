ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS receipt_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS date_string VARCHAR(150);

UPDATE receipts
SET receipt_date = created_at
WHERE receipt_date IS NULL;

ALTER TABLE receipts
  ALTER COLUMN receipt_date SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN receipt_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_receipts_status_receipt_date
  ON receipts (status, receipt_date DESC);
