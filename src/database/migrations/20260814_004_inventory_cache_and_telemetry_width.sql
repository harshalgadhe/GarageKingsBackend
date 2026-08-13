-- Compatibility cache used by current product, receipt, and inventory flows.
-- Inventory batches remain the detailed source of truth.
CREATE TABLE IF NOT EXISTS inventory (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  quantity_available INT NOT NULL DEFAULT 0 CHECK (quantity_available >= 0),
  quantity_reserved INT NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  quantity_sold INT NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  quantity_returned INT NOT NULL DEFAULT 0 CHECK (quantity_returned >= 0),
  quantity_damaged INT NOT NULL DEFAULT 0 CHECK (quantity_damaged >= 0),
  quantity_locked INT NOT NULL DEFAULT 0 CHECK (quantity_locked >= 0),
  warehouse_shelf_location VARCHAR(255),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(product_id);

-- Browser user-agent and exception class values can legitimately exceed the
-- original 100-character limits. Telemetry must never mask the primary error.
ALTER TABLE telemetry_errors
  ALTER COLUMN exception_type TYPE VARCHAR(255),
  ALTER COLUMN module TYPE VARCHAR(255),
  ALTER COLUMN latest_session_id TYPE VARCHAR(255),
  ALTER COLUMN latest_browser TYPE TEXT,
  ALTER COLUMN latest_device TYPE VARCHAR(255),
  ALTER COLUMN latest_correlation_id TYPE VARCHAR(255);

