-- Catalog runtime compatibility.
-- Replaces schema mutations that were previously hidden in application startup.

CREATE TABLE IF NOT EXISTS global_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) UNIQUE NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  logo_url TEXT,
  cover_image_url TEXT,
  website TEXT,
  display_order INT NOT NULL DEFAULT 0,
  is_visible BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(50) NOT NULL DEFAULT 'Active',
  accent_color VARCHAR(20) NOT NULL DEFAULT '#C8AE7D',
  secondary_color VARCHAR(20) NOT NULL DEFAULT '#F4F1EC',
  background_color VARCHAR(20) NOT NULL DEFAULT '#080706',
  theme_variant VARCHAR(30) NOT NULL DEFAULT 'archive',
  logo_treatment VARCHAR(20) NOT NULL DEFAULT 'natural',
  kicker VARCHAR(120),
  headline VARCHAR(180),
  description TEXT,
  origin_label VARCHAR(120),
  style_label VARCHAR(120),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP WITH TIME ZONE
);

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS accent_color VARCHAR(20) NOT NULL DEFAULT '#C8AE7D',
  ADD COLUMN IF NOT EXISTS secondary_color VARCHAR(20) NOT NULL DEFAULT '#F4F1EC',
  ADD COLUMN IF NOT EXISTS background_color VARCHAR(20) NOT NULL DEFAULT '#080706',
  ADD COLUMN IF NOT EXISTS theme_variant VARCHAR(30) NOT NULL DEFAULT 'archive',
  ADD COLUMN IF NOT EXISTS logo_treatment VARCHAR(20) NOT NULL DEFAULT 'natural',
  ADD COLUMN IF NOT EXISTS kicker VARCHAR(120),
  ADD COLUMN IF NOT EXISTS headline VARCHAR(180),
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS origin_label VARCHAR(120),
  ADD COLUMN IF NOT EXISTS style_label VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS casing VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tag VARCHAR(100),
  ADD COLUMN IF NOT EXISTS subtags VARCHAR(100)[] NOT NULL DEFAULT '{}'::VARCHAR[],
  ADD COLUMN IF NOT EXISTS price NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS po_amount NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS stock INT,
  ADD COLUMN IF NOT EXISTS available_stock INT,
  ADD COLUMN IF NOT EXISTS customer_eta DATE,
  ADD COLUMN IF NOT EXISTS image TEXT,
  ADD COLUMN IF NOT EXISTS images TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

UPDATE products
SET price = COALESCE(price, selling_price, base_price),
    po_amount = COALESCE(po_amount, prebook_deposit_amount),
    stock = COALESCE(stock, total_stock, 0),
    available_stock = COALESCE(available_stock, total_stock - locked_stock - sold_stock, 0),
    subtags = CASE WHEN cardinality(subtags) = 0 THEN COALESCE(tags, '{}'::VARCHAR[]) ELSE subtags END;

ALTER TABLE product_images
  ADD COLUMN IF NOT EXISTS medium_url TEXT,
  ADD COLUMN IF NOT EXISTS full_url TEXT;

UPDATE product_images
SET full_url = COALESCE(full_url, thumbnail_url),
    medium_url = COALESCE(medium_url, thumbnail_url, full_url),
    thumbnail_url = COALESCE(thumbnail_url, full_url, medium_url);

WITH catalog_brands AS (
  SELECT DISTINCT TRIM(brand) AS name
  FROM products
  WHERE deleted_at IS NULL AND TRIM(COALESCE(brand, '')) <> ''
)
INSERT INTO brands (name, slug, display_order)
SELECT name,
       TRIM(BOTH '-' FROM LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '-', 'g'))),
       ROW_NUMBER() OVER (ORDER BY name)
FROM catalog_brands
ON CONFLICT DO NOTHING;
