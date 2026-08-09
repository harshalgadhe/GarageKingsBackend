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

WITH catalog_brands AS (
  SELECT DISTINCT TRIM(p.brand) AS name
  FROM products p
  WHERE p.deleted_at IS NULL
    AND TRIM(COALESCE(p.brand, '')) <> ''
), missing_brands AS (
  SELECT c.name,
         LOWER(REGEXP_REPLACE(c.name, '[^a-zA-Z0-9]+', '-', 'g')) AS slug,
         ROW_NUMBER() OVER (ORDER BY c.name) AS position
  FROM catalog_brands c
  WHERE NOT EXISTS (
    SELECT 1 FROM brands b
    WHERE b.deleted_at IS NULL
      AND LOWER(TRIM(b.name)) = LOWER(c.name)
  )
)
INSERT INTO brands (
  name, slug, display_order, is_visible, status,
  accent_color, secondary_color, background_color, theme_variant, logo_treatment,
  kicker, headline, description, origin_label, style_label
)
SELECT m.name,
       m.slug,
       COALESCE((SELECT MAX(display_order) FROM brands), 0) + m.position,
       true,
       'Active',
       '#C8AE7D',
       '#F4F1EC',
       '#080706',
       'archive',
       'natural',
       'Collector marque',
       'Discover the collection.',
       'Explore the GarageKings selection of ' || m.name || ' models, catalogued with current availability and collection details.',
       'GarageKings collection',
       'Curated models'
FROM missing_brands m
WHERE NOT EXISTS (SELECT 1 FROM brands b WHERE b.slug = m.slug)
ON CONFLICT DO NOTHING;

UPDATE brands SET
  logo_url = COALESCE(logo_url, '/brand-logos/hot-wheels.svg'),
  accent_color = '#FFD21C', secondary_color = '#42D9F5', background_color = '#071B3A',
  theme_variant = 'velocity', logo_treatment = 'natural', kicker = 'Since 1968',
  headline = 'Built to move. Made to be remembered.',
  description = 'Bold colour, graphic energy and decades of automotive imagination, interpreted for a collector-first archive.',
  origin_label = 'Mattel', style_label = 'Icons in motion'
WHERE slug = 'hot-wheels';

UPDATE brands SET
  logo_url = '/brand-logos/mini-gt.svg',
  accent_color = '#E6332A', secondary_color = '#F1F1ED', background_color = '#070707',
  theme_variant = 'precision', logo_treatment = 'invert', kicker = 'True scale. Real detail.',
  headline = 'Engineered small. Experienced full-size.',
  description = 'Road cars and race machines presented with restrained, specification-led precision.',
  origin_label = 'TSM Model', style_label = 'Precision at 1:64'
WHERE slug = 'mini-gt';

UPDATE brands SET
  logo_url = COALESCE(logo_url, '/brand-logos/pop-race.png'),
  accent_color = '#E0101B', secondary_color = '#FFFFFF', background_color = '#B80712',
  theme_variant = 'race', logo_treatment = 'natural', kicker = 'Race culture in miniature',
  headline = 'After dark, the grid comes alive.',
  description = 'Modern GT, tuner and racing culture with a darker, track-inspired editorial treatment.',
  origin_label = 'Hong Kong', style_label = 'Boutique motorsport'
WHERE slug = 'pop-race';

UPDATE brands SET
  logo_url = COALESCE(logo_url, '/brand-logos/time-micro.png'),
  accent_color = '#FFFFFF', secondary_color = '#C9CDD2', background_color = '#050505',
  theme_variant = 'precision', logo_treatment = 'natural', kicker = 'Limited visual editions',
  headline = 'Colour is part of the story.',
  description = 'Expressive liveries and display-focused miniatures staged like limited poster editions.',
  origin_label = 'Collector series', style_label = 'Livery stories'
WHERE slug = 'time-micro';
