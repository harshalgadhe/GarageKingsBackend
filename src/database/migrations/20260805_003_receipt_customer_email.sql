ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_receipts_customer_email
  ON receipts(customer_email);
