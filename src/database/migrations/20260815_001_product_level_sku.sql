-- The products table owns SKU uniqueness. Keep historical variant SKU values
-- for compatibility, but variants must not reserve catalogue identifiers.
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_sku_key;
DROP INDEX IF EXISTS idx_variants_sku_active;
DROP INDEX IF EXISTS idx_variants_sku_active_normalized;
