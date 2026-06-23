-- ============================================================================
-- GARAGEKINGS ENTERPRISE POSTGRESQL SCHEMA MIGRATION V2 (ALTERATION & NEW SCHEMAS)
-- Adds fields for RBAC, stock reservation, CRM, expenses, founder splits, finance, analytics, and immutable audit logs.
-- ============================================================================

-- 1. Modify Users Table
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'Viewer';
ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_token_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ALTER COLUMN cognito_sub DROP NOT NULL;

-- 2. Modify Products Table
ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(12, 2) DEFAULT 0.00;
ALTER TABLE products ADD COLUMN IF NOT EXISTS selling_price NUMERIC(12, 2) DEFAULT 0.00;
ALTER TABLE products ADD COLUMN IF NOT EXISTS total_stock INT DEFAULT 10;
ALTER TABLE products ADD COLUMN IF NOT EXISTS locked_stock INT DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sold_stock INT DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS arrival_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS release_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- 3. Modify Orders Table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS screenshot_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- 4. Modify Customers Table
ALTER TABLE customers ADD COLUMN IF NOT EXISTS instagram_username VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- 5. Create Expenses Table
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CONSTRAINT chk_expense_amt CHECK (amount >= 0),
    category VARCHAR(100) NOT NULL, -- 'Inventory Purchase', 'Shipping', 'Packaging', 'Marketing', 'Website', 'Tools', 'Domain', 'Miscellaneous'
    paid_by VARCHAR(100) NOT NULL, -- founder name
    date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_expenses_cat ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

-- 6. Create Split Settlements Table
CREATE TABLE IF NOT EXISTS split_settlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_founder VARCHAR(100) NOT NULL,
    to_founder VARCHAR(100) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CONSTRAINT chk_settle_amt CHECK (amount > 0),
    notes TEXT,
    date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. Modify Audit Logs Table for advanced tracking
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS performed_by VARCHAR(255);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(50);

-- 8. Seed Default Owner Account if not exists
-- Hashed password for 'admin123' using bcrypt (wait, we can hash it dynamically in node, but we can seed it with a placeholder or run it via a node script)
