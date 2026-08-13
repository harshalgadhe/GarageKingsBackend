ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_active_normalized
  ON products (UPPER(TRIM(sku)))
  WHERE deleted_at IS NULL;

ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_sku_key;
DROP INDEX IF EXISTS idx_variants_sku_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_sku_active_normalized
  ON product_variants (UPPER(TRIM(sku)))
  WHERE deleted_at IS NULL;
