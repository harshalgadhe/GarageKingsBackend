-- Public catalog search and filtering indexes.
-- pg_trgm allows the existing contains search (%query%) to use an index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_products_public_created_at
  ON products (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_public_brand_lower
  ON products (LOWER(brand))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_search_model_name_trgm
  ON products USING GIN (LOWER(model_name) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_search_sku_trgm
  ON products USING GIN (LOWER(sku) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_search_brand_trgm
  ON products USING GIN (LOWER(brand) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_search_series_trgm
  ON products USING GIN (LOWER(series) gin_trgm_ops)
  WHERE deleted_at IS NULL;
