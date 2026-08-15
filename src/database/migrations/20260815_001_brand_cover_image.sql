-- Optional editorial photography for public brand cards.
-- This is intentionally separate from logo_url so identity artwork is never
-- stretched or cropped to behave like a photographic cover.
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
