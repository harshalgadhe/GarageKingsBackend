ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_products_public_catalog
  ON products (created_at DESC)
  WHERE deleted_at IS NULL AND is_public = TRUE;
