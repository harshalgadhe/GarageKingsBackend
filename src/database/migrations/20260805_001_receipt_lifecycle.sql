ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50),
  ADD COLUMN IF NOT EXISTS customer_instagram VARCHAR(100),
  ADD COLUMN IF NOT EXISTS customer_address TEXT,
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'Issued',
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS voided_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_receipts_status_created
  ON receipts(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_receipts_pending_active
  ON receipts(pending_balance)
  WHERE status = 'Issued' AND pending_balance > 0;

CREATE TABLE IF NOT EXISTS receipt_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'Pending',
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,
  pdf_s3_url VARCHAR(512),
  error_log TEXT,
  correlation_id VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_receipt_jobs_parent
  ON receipt_generation_jobs(receipt_id);

CREATE INDEX IF NOT EXISTS idx_receipt_jobs_status
  ON receipt_generation_jobs(status);
