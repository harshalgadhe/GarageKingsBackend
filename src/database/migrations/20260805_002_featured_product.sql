ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_single_featured
  ON products (is_featured)
  WHERE is_featured = TRUE AND deleted_at IS NULL;
