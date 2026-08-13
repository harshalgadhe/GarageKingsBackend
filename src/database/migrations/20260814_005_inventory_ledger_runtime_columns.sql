-- Bring the immutable ledger in line with every current writer. Receipt/order
-- movements may not have a batch, while inventory adjustments also retain the
-- parent product and the retail price observed at movement time.
ALTER TABLE inventory_ledger
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

ALTER TABLE inventory_ledger
  ALTER COLUMN batch_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_ledger_product ON inventory_ledger(product_id);

