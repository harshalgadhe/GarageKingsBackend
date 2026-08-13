-- ============================================================================
-- GARAGEKINGS ENTERPRISE POSTGRESQL DATABASE SCHEMA (DDL)
-- Version 1.0 - Production Stack
-- ============================================================================

-- Enable UUID extension for secure, non-sequential resource identifiers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Custom Types
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_tx_type') THEN
        CREATE TYPE inventory_tx_type AS ENUM ('Added', 'Edited', 'Reserved', 'Sold', 'Returned', 'Cancelled', 'Deleted');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
        CREATE TYPE order_status AS ENUM ('Pending', 'Paid', 'Shipped', 'Delivered', 'Cancelled', 'Confirmed', 'Reserved', 'Verification Pending');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'listing_status') THEN
        CREATE TYPE listing_status AS ENUM ('Active', 'Sold', 'Delisted');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'offer_status') THEN
        CREATE TYPE offer_status AS ENUM ('Pending', 'Accepted', 'Declined', 'Withdrawn');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auction_status') THEN
        CREATE TYPE auction_status AS ENUM ('Upcoming', 'Active', 'Completed', 'Cancelled');
    END IF;
END$$;

-- 1. Users Table (Core Auth mapped to AWS Cognito)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cognito_sub VARCHAR(255) UNIQUE,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(50) DEFAULT 'Viewer',
    password_hash VARCHAR(255),
    refresh_token_hash VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_users_cognito_sub ON users(cognito_sub);

-- 2. Profiles Table (Collector Identity & Reputation)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100),
    avatar_url VARCHAR(512),
    collector_rank VARCHAR(50) DEFAULT 'Novice Collector',
    bio TEXT,
    instagram_handle VARCHAR(100),
    whatsapp_opt_in BOOLEAN DEFAULT FALSE,
    seller_rating NUMERIC(3, 2) DEFAULT 0.00 CHECK (seller_rating >= 0.00 AND seller_rating <= 5.00),
    buyer_rating NUMERIC(3, 2) DEFAULT 0.00 CHECK (buyer_rating >= 0.00 AND buyer_rating <= 5.00),
    successful_sales INT DEFAULT 0 CONSTRAINT chk_sales CHECK (successful_sales >= 0),
    successful_purchases INT DEFAULT 0 CONSTRAINT chk_purchases CHECK (successful_purchases >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);

-- 3. Products Table (Master Castings Catalog)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand VARCHAR(100) NOT NULL,
    model_name VARCHAR(255) NOT NULL,
    series VARCHAR(255),
    scale VARCHAR(20) DEFAULT '1:64',
    sku VARCHAR(100) UNIQUE NOT NULL,
    rarity_level VARCHAR(100) DEFAULT 'Standard Edition',
    base_price NUMERIC(12, 2) NOT NULL CONSTRAINT chk_base_price CHECK (base_price >= 0),
    description TEXT,
    tags VARCHAR(50)[] DEFAULT '{}'::VARCHAR[],
    availability_state VARCHAR(50) NOT NULL DEFAULT 'Available',
    category VARCHAR(100),
    casing_types VARCHAR(50)[] DEFAULT '{"box"}'::VARCHAR[],
    purchase_price NUMERIC(12, 2) DEFAULT 0.00,
    selling_price NUMERIC(12, 2) DEFAULT 0.00,
    total_stock INT DEFAULT 0,
    sold_stock INT DEFAULT 0,
    locked_stock INT DEFAULT 0,
    supplier VARCHAR(255),
    arrival_date TIMESTAMP WITH TIME ZONE,
    release_date TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) DEFAULT 'Draft',
    show_on_homepage BOOLEAN DEFAULT TRUE,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    max_qty_per_customer INT DEFAULT NULL,
    is_prebook BOOLEAN DEFAULT FALSE,
    prebook_deposit_amount NUMERIC(12, 2) DEFAULT NULL,
    created_by VARCHAR(255),
    updated_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_products_brand_model ON products(brand, model_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_single_featured ON products(is_featured) WHERE is_featured = TRUE AND deleted_at IS NULL;

-- 3.2 Casing Types Table (Relational Casing Normalization)
CREATE TABLE IF NOT EXISTS casing_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3.3 Product Variants Table (Commerce Entity)
CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    casing_type_id UUID NOT NULL REFERENCES casing_types(id) ON DELETE RESTRICT,
    sku VARCHAR(100) UNIQUE NOT NULL,
    barcode VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (selling_price >= 0),
    customer_eta DATE,
    visibility VARCHAR(50) NOT NULL DEFAULT 'Visible',
    status VARCHAR(50) NOT NULL DEFAULT 'Draft',
    sales_status VARCHAR(50) NOT NULL DEFAULT 'Coming Soon',
    dimensions VARCHAR(100),
    weight NUMERIC(8, 2),
    variant_attributes JSONB DEFAULT '{}'::JSONB,
    total_stock INT NOT NULL DEFAULT 0 CHECK (total_stock >= 0),
    sold_stock INT NOT NULL DEFAULT 0 CHECK (sold_stock >= 0),
    locked_stock INT NOT NULL DEFAULT 0 CHECK (locked_stock >= 0),
    created_by VARCHAR(255),
    updated_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_sku_active ON product_variants(sku) WHERE deleted_at IS NULL;

-- 3.4 Product Price History Table (Auditing Pricing Changes)
CREATE TABLE IF NOT EXISTS product_price_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    previous_price NUMERIC(12, 2) NOT NULL CHECK (previous_price >= 0),
    new_price NUMERIC(12, 2) NOT NULL CHECK (new_price >= 0),
    reason TEXT,
    admin_email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prod_price_history_variant ON product_price_history(variant_id);

-- 3.5 Catalog Prices Table (Price Books Scheduling)
CREATE TABLE IF NOT EXISTS catalog_prices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    selling_price NUMERIC(12, 2) NOT NULL CHECK (selling_price >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    marketplace_id VARCHAR(50) DEFAULT 'website',
    customer_type VARCHAR(50) DEFAULT 'Retail',
    reason TEXT,
    effective_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    effective_to TIMESTAMP WITH TIME ZONE,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_catalog_prices_variant ON catalog_prices(variant_id);

-- 4. Product Images Table (Multi-resolution Assets Store)
CREATE TABLE IF NOT EXISTS product_images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
    media_type VARCHAR(20) NOT NULL DEFAULT 'image',
    url TEXT NOT NULL,
    thumbnail_url TEXT,
    alt_text VARCHAR(255),
    is_primary BOOLEAN DEFAULT FALSE,
    display_order INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_product_images_parent ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_product_images_variant ON product_images(variant_id);

-- 5. Suppliers Table (formerly Distributors)
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) UNIQUE NOT NULL,
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),
    address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5.2 Purchase Orders Table (Legacy support)
CREATE TABLE IF NOT EXISTS purchase_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_number VARCHAR(100) UNIQUE NOT NULL,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
    status VARCHAR(50) NOT NULL DEFAULT 'Draft',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5.3 Supplier Purchases Table
CREATE TABLE IF NOT EXISTS supplier_purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_arrival_date DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'Draft', -- 'Draft', 'Awaiting Advance', 'Booked', 'In Transit', 'Partially Received', 'Fully Received', 'Completed', 'Cancelled'
    total_value NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5.4 Supplier Purchase Items Table
CREATE TABLE IF NOT EXISTS supplier_purchase_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    purchase_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    supplier_eta DATE,
    warehouse_eta DATE,
    received_quantity_cache INT NOT NULL DEFAULT 0 CHECK (received_quantity_cache >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Cash accounts are referenced by supplier payments below, so they must be
-- created before the finance tables that carry the foreign key.
CREATE TABLE IF NOT EXISTS cash_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) UNIQUE NOT NULL,
    type VARCHAR(100) DEFAULT 'Bank',
    opening_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) DEFAULT 'INR',
    display_order INT DEFAULT 0,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- 5.5 Supplier Payments Table (Immutable Payment History)
CREATE TABLE IF NOT EXISTS supplier_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    cash_account_id UUID NOT NULL REFERENCES cash_accounts(id) ON DELETE RESTRICT,
    payment_method VARCHAR(50) NOT NULL, -- 'Bank Transfer', 'UPI', 'Cash'
    reference_number VARCHAR(255),
    notes TEXT,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5.6 Supplier Purchase Receipts Table (Immutable Receiving Log)
CREATE TABLE IF NOT EXISTS supplier_purchase_receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id) ON DELETE RESTRICT,
    receipt_number VARCHAR(100) UNIQUE NOT NULL, -- e.g., 'PR-2026-0001'
    received_date DATE NOT NULL DEFAULT CURRENT_DATE,
    received_by VARCHAR(255) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5.7 Supplier Purchase Receipt Items Table
CREATE TABLE IF NOT EXISTS supplier_purchase_receipt_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_receipt_id UUID NOT NULL REFERENCES supplier_purchase_receipts(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity_received INT NOT NULL CHECK (quantity_received >= 0),
    quantity_short INT NOT NULL DEFAULT 0 CHECK (quantity_short >= 0),
    quantity_damaged INT NOT NULL DEFAULT 0 CHECK (quantity_damaged >= 0),
    quantity_over INT NOT NULL DEFAULT 0 CHECK (quantity_over >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5.8 Supplier Purchase Attachments Table
CREATE TABLE IF NOT EXISTS supplier_purchase_attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_purchase_id UUID REFERENCES supplier_purchases(id) ON DELETE CASCADE,
    purchase_receipt_id UUID REFERENCES supplier_purchase_receipts(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(512) NOT NULL,
    uploaded_by VARCHAR(255) NOT NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5.9 Inventory Batches Table (Enhanced)
CREATE TABLE IF NOT EXISTS inventory_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_purchase_id UUID REFERENCES supplier_purchases(id) ON DELETE SET NULL,
    purchase_receipt_id UUID REFERENCES supplier_purchase_receipts(id) ON DELETE SET NULL,
    purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
    sku VARCHAR(100) NOT NULL,
    purchase_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    quantity_received INT NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
    quantity_available INT NOT NULL DEFAULT 0 CHECK (quantity_available >= 0),
    quantity_reserved INT NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
    quantity_sold INT NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
    quantity_returned INT NOT NULL DEFAULT 0 CHECK (quantity_returned >= 0),
    quantity_damaged INT NOT NULL DEFAULT 0 CHECK (quantity_damaged >= 0),
    status VARCHAR(50) NOT NULL DEFAULT 'Open',
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inv_batches_fifo ON inventory_batches(variant_id, received_at ASC);

-- 7. Customers Table (CRM Record Tracks)
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    instagram VARCHAR(100),
    instagram_username VARCHAR(100),
    address TEXT,
    email VARCHAR(255) UNIQUE NOT NULL,
    city VARCHAR(100) DEFAULT 'Unknown',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_cust_phone_search ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_cust_name_search ON customers(full_name);

-- 10. Orders Table (E-commerce Purchases)
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status order_status DEFAULT 'Pending',
    total_price NUMERIC(12, 2) NOT NULL CONSTRAINT chk_order_total CHECK (total_price >= 0),
    shipping_address TEXT NOT NULL,
    tracking_number VARCHAR(100),
    screenshot_url TEXT,
    reservation_expires_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    idempotency_key VARCHAR(255) UNIQUE,
    courier_partner VARCHAR(100),
    shipping_cost NUMERIC(12, 2) DEFAULT 0.00,
    packaging_cost NUMERIC(12, 2) DEFAULT 0.00,
    dispatch_date TIMESTAMP WITH TIME ZONE,
    delivery_date TIMESTAMP WITH TIME ZONE,
    booking_type VARCHAR(20) DEFAULT 'standard',
    advance_amount NUMERIC(12, 2) DEFAULT 0.00,
    remaining_amount NUMERIC(12, 2) DEFAULT 0.00,
    advance_screenshot_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

-- 11. Order Items Table
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    qty INT NOT NULL DEFAULT 1 CHECK (qty > 0),
    price_at_purchase NUMERIC(12, 2) NOT NULL,
    purchase_price_at_purchase NUMERIC(12, 2) DEFAULT 0.00,
    variant_name_snapshot VARCHAR(255) NOT NULL,
    sku_snapshot VARCHAR(100) NOT NULL,
    barcode_snapshot VARCHAR(100),
    brand_snapshot VARCHAR(100) NOT NULL,
    casing_snapshot VARCHAR(100) NOT NULL,
    manufacturer_snapshot VARCHAR(100) NOT NULL,
    metadata_snapshot JSONB DEFAULT '{}'::JSONB
);
CREATE INDEX IF NOT EXISTS idx_order_items_parent ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_variant ON order_items(variant_id);

-- 11.2 Order Inventory Allocations Table
CREATE TABLE IF NOT EXISTS order_inventory_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES inventory_batches(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    purchase_price NUMERIC(12, 2) NOT NULL,
    allocated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_allocations_item ON order_inventory_allocations(order_item_id);

-- 6. Inventory Ledger Table (Immutable Movement Trail)
CREATE TABLE IF NOT EXISTS inventory_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    batch_id UUID REFERENCES inventory_batches(id) ON DELETE RESTRICT,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,
    quantity_changed INT NOT NULL,
    purchase_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    reason TEXT NOT NULL,
    performed_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ledger_variant ON inventory_ledger(variant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_batch ON inventory_ledger(batch_id);

-- 6.2 Inventory Snapshots Table
CREATE TABLE IF NOT EXISTS inventory_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    quantity_available INT NOT NULL DEFAULT 0,
    quantity_reserved INT NOT NULL DEFAULT 0,
    quantity_sold INT NOT NULL DEFAULT 0,
    quantity_returned INT NOT NULL DEFAULT 0,
    quantity_damaged INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (variant_id, snapshot_date)
);

-- 6.3 Cycle Count Audits Forward Compatibility
CREATE TABLE IF NOT EXISTS inventory_cycle_counts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    audit_date DATE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Draft',
    performed_by VARCHAR(255) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_cycle_count_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cycle_count_id UUID NOT NULL REFERENCES inventory_cycle_counts(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES inventory_batches(id) ON DELETE RESTRICT,
    system_qty INT NOT NULL,
    physical_qty INT NOT NULL,
    variance INT NOT NULL,
    adjustment_reason TEXT
);

-- Legacy Inventory Transactions Table (Mandatory Audit Logs)
CREATE TABLE IF NOT EXISTS inventory_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    type inventory_tx_type NOT NULL,
    quantity_changed INT NOT NULL,
    reason TEXT NOT NULL,
    admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inv_tx_var_type ON inventory_transactions(variant_id, type);

-- 8. Receipts Table (In-person & Manual Billing)
CREATE TABLE IF NOT EXISTS receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    receipt_number VARCHAR(100) UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    format_type VARCHAR(50) DEFAULT 'standard',
    tax_percent NUMERIC(5, 2) DEFAULT 0.00,
    tax_amount NUMERIC(12, 2) DEFAULT 0.00,
    shipping_charges NUMERIC(12, 2) DEFAULT 0.00,
    total_amount NUMERIC(12, 2) NOT NULL CONSTRAINT chk_receipt_total CHECK (total_amount >= 0),
    advance_paid NUMERIC(12, 2) DEFAULT 0.00,
    pending_balance NUMERIC(12, 2) DEFAULT 0.00,
    footer_note TEXT,
    pdf_url VARCHAR(512),
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    customer_instagram VARCHAR(100),
    customer_address TEXT,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Issued',
    void_reason TEXT,
    voided_at TIMESTAMP WITH TIME ZONE,
    voided_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_receipts_num ON receipts(receipt_number);
CREATE INDEX IF NOT EXISTS idx_receipts_customer ON receipts(customer_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status_created ON receipts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_pending_active ON receipts(pending_balance) WHERE status = 'Issued' AND pending_balance > 0;

-- 9. Receipt Items Table
CREATE TABLE IF NOT EXISTS receipt_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    qty INT NOT NULL DEFAULT 1 CHECK (qty > 0),
    amount NUMERIC(12, 2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_items_parent ON receipt_items(receipt_id);

-- 9.5 Receipt Generation Jobs Table (Queue tracks for PDF generator worker)
CREATE TABLE IF NOT EXISTS receipt_generation_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'Pending',
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    pdf_s3_url VARCHAR(512),
    error_log TEXT,
    correlation_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_receipt_jobs_parent ON receipt_generation_jobs(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_jobs_status ON receipt_generation_jobs(status);

-- 12. Wishlists Table
CREATE TABLE IF NOT EXISTS wishlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_wishlists_user ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_variant ON wishlists(variant_id);

-- 13. Garage Items Table (Collection Vault)
CREATE TABLE IF NOT EXISTS garage_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    brand VARCHAR(100) NOT NULL,
    model_name VARCHAR(255) NOT NULL,
    scale VARCHAR(20) DEFAULT '1:64',
    series VARCHAR(255),
    rarity_level VARCHAR(100) DEFAULT 'Standard Edition',
    description TEXT,
    condition_grade VARCHAR(100) NOT NULL,
    is_custom BOOLEAN DEFAULT FALSE,
    estimated_value NUMERIC(12, 2) DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_garage_user ON garage_items(user_id);

-- 14. Garage Item Images Table
CREATE TABLE IF NOT EXISTS garage_item_images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    garage_item_id UUID NOT NULL REFERENCES garage_items(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_garage_images_parent ON garage_item_images(garage_item_id);

-- 15. Drops Table (Timed Releases)
CREATE TABLE IF NOT EXISTS drops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
    description TEXT,
    label VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_drops_schedule ON drops(scheduled_time, is_active);

-- 16. Drop Variants Table
CREATE TABLE IF NOT EXISTS drop_variants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drop_id UUID NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    allocated_qty INT NOT NULL DEFAULT 1 CHECK (allocated_qty > 0),
    UNIQUE(drop_id, variant_id)
);

-- 17. Notifications Table (System Messaging alerts)
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications(user_id, is_read);

-- 18. Marketplace Listings Table (Member Direct Listings)
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255),
    description TEXT,
    visibility VARCHAR(50) NOT NULL DEFAULT 'Visible',
    status listing_status DEFAULT 'Active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_market_seller_status ON marketplace_listings(seller_id, status);

-- 18.2 Marketplace Listing Items Table (Supporting Bundles)
CREATE TABLE IF NOT EXISTS marketplace_listing_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    asking_price NUMERIC(12, 2) NOT NULL CHECK (asking_price > 0),
    condition_grade VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_market_listing_items_parent ON marketplace_listing_items(listing_id);
CREATE INDEX IF NOT EXISTS idx_market_listing_items_variant ON marketplace_listing_items(variant_id);

-- 19. Offers Table (Negotiations)
CREATE TABLE IF NOT EXISTS offers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offered_price NUMERIC(12, 2) NOT NULL CONSTRAINT chk_offer_price CHECK (offered_price > 0),
    status offer_status DEFAULT 'Pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_offers_listing ON offers(listing_id);
CREATE INDEX IF NOT EXISTS idx_offers_buyer ON offers(buyer_id);

-- 20. Watchlists Table (Saved Listings)
CREATE TABLE IF NOT EXISTS watchlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);

-- 21. Auction Events Table (Auction Management)
CREATE TABLE IF NOT EXISTS auction_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    title VARCHAR(255) NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    starting_bid NUMERIC(12, 2) NOT NULL CONSTRAINT chk_start_bid CHECK (starting_bid >= 0),
    reserve_price NUMERIC(12, 2) DEFAULT 0.00,
    status auction_status DEFAULT 'Upcoming',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_time CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_auction_status ON auction_events(status, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_auction_variant ON auction_events(variant_id);

-- 22. Auction Bids Table (Real-time Bidding Entries)
CREATE TABLE IF NOT EXISTS auction_bids (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id UUID NOT NULL REFERENCES auction_events(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CONSTRAINT chk_bid_amt CHECK (amount > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auction_bids_amt ON auction_bids(auction_id, amount DESC);
CREATE INDEX IF NOT EXISTS idx_auction_bids_user ON auction_bids(user_id);

-- 23. Auction Winners Table (Auction Checkout Mapping)
CREATE TABLE IF NOT EXISTS auction_winners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id UUID UNIQUE NOT NULL REFERENCES auction_events(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    winning_bid_id UUID UNIQUE NOT NULL REFERENCES auction_bids(id) ON DELETE RESTRICT,
    checkout_order_id UUID UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 24. Admin Audit Logs Table (Mandatory Internal Logging System)
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action VARCHAR(255) NOT NULL, -- e.g., 'UPDATE_INVENTORY', 'DELETE_PRODUCT'
    entity VARCHAR(100) NOT NULL, -- e.g., 'inventory', 'products'
    entity_id VARCHAR(100) NOT NULL,
    before_state JSONB,
    after_state JSONB,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit_logs(admin_id, timestamp DESC);

-- 25. General Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action VARCHAR(255) NOT NULL,
    entity VARCHAR(100) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    before_state JSONB,
    after_state JSONB,
    correlation_id VARCHAR(100),
    user_id UUID,
    category VARCHAR(50),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Helper mapping table for firestore migrations
CREATE TABLE IF NOT EXISTS id_mappings (
    firestore_id VARCHAR(100) PRIMARY KEY,
    postgresql_id UUID NOT NULL,
    collection_name VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_id_mappings_ref ON id_mappings(collection_name, firestore_id);

-- Dead Letter Queue for dual-writes sync anomalies
CREATE TABLE IF NOT EXISTS dual_write_dlq (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    error_message TEXT NOT NULL,
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 26. Telemetry Errors Table (Aggregated Runtime Errors)
CREATE TABLE IF NOT EXISTS telemetry_errors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fingerprint VARCHAR(64) UNIQUE NOT NULL,
    error_type VARCHAR(20) NOT NULL, -- 'Frontend' or 'Backend'
    category VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    message TEXT NOT NULL,
    stack_trace TEXT,
    exception_type VARCHAR(100),
    severity VARCHAR(20) DEFAULT 'Error',
    module VARCHAR(100),
    route VARCHAR(255),
    endpoint VARCHAR(255),
    first_occurrence TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_occurrence TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    occurrence_count INT DEFAULT 1,
    latest_user_id UUID,
    latest_user_email VARCHAR(255),
    latest_session_id VARCHAR(100),
    latest_url VARCHAR(512),
    latest_browser VARCHAR(100),
    latest_device VARCHAR(100),
    latest_correlation_id VARCHAR(100),
    latest_payload JSONB,
    latest_duration INT,
    build_version VARCHAR(50),
    acknowledged BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_telemetry_errors_fingerprint ON telemetry_errors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_telemetry_errors_last ON telemetry_errors(last_occurrence DESC);

-- 27. Performance Metrics Table (Lightweight performance metrics)
CREATE TABLE IF NOT EXISTS performance_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    metric_type VARCHAR(50) NOT NULL, -- 'api_latency', 'query_duration', 'page_load', 'payload_size'
    feature VARCHAR(50) NOT NULL, -- 'Authentication', 'Marketplace', 'Orders', etc.
    endpoint VARCHAR(255),
    duration_ms INT,
    payload_size_bytes INT,
    correlation_id VARCHAR(100),
    user_id UUID,
    metadata JSONB,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_type_timestamp ON performance_metrics(metric_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_feature ON performance_metrics(feature);

-- 28. Expenses Table
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    category VARCHAR(100) NOT NULL,
    paid_by VARCHAR(100) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_expenses_cat ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

-- 29. Split Settlements Table
CREATE TABLE IF NOT EXISTS split_settlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_founder VARCHAR(100) NOT NULL,
    to_founder VARCHAR(100) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    notes TEXT,
    date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 30. Reservations Table (Legacy Checkout holds)
CREATE TABLE IF NOT EXISTS reservations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    quantity INT DEFAULT 1 CHECK (quantity > 0),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    released_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) DEFAULT 'Active',
    idempotency_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 31. System Notifications Table
CREATE TABLE IF NOT EXISTS system_notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'info',
    order_id UUID DEFAULT NULL REFERENCES orders(id) ON DELETE SET NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 32. Homepage Sections Table
CREATE TABLE IF NOT EXISTS homepage_sections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    section_name VARCHAR(100) UNIQUE NOT NULL,
    is_visible BOOLEAN DEFAULT TRUE,
    display_order INT DEFAULT 0,
    metadata JSONB DEFAULT '{}'::JSONB
);

-- 33. Cash Accounts Table
CREATE TABLE IF NOT EXISTS cash_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) UNIQUE NOT NULL,
    type VARCHAR(100) DEFAULT 'Bank', -- 'Bank', 'UPI', 'Cash Drawer', 'Petty Cash', 'Gateway'
    opening_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) DEFAULT 'INR',
    display_order INT DEFAULT 0,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- 34. Refunds Table
CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    status VARCHAR(50) NOT NULL DEFAULT 'Completed', -- 'Pending', 'Completed'
    reason TEXT,
    restock_inventory BOOLEAN DEFAULT TRUE,
    is_damaged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

-- 35. Immutable Cash Transaction Ledger Table
CREATE TABLE IF NOT EXISTS cash_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cash_account_id UUID REFERENCES cash_accounts(id) ON DELETE SET NULL,
    amount NUMERIC(12, 2) NOT NULL, -- positive for inflows, negative for outflows
    type VARCHAR(100) NOT NULL, -- 'Customer Payment', 'Pre-order Advance', 'Pre-order Remaining Payment', 'Founder Contribution', 'Founder Reimbursement', 'Founder Personal Inventory Purchase', 'Inventory Purchase', 'Inventory Purchase Adjustment', 'Operating Expense', 'Refund', 'Refund Reversal', 'Manual Adjustment', 'Owner Draw', 'Settlement Between Founders', 'Inventory Write-off', 'Inventory Damage', 'Inventory Loss', 'Inventory Correction', 'Cash Adjustment'
    status VARCHAR(50) NOT NULL DEFAULT 'Completed', -- 'Pending', 'Completed', 'Cancelled', 'Reversed', 'Failed'
    source_type VARCHAR(100) NOT NULL, -- 'Order', 'Expense', 'Inventory Batch', 'Founder Ledger', 'Refund', 'Invoice', 'Manual Adjustment'
    source_id VARCHAR(100) NOT NULL, -- ID of the source entity
    reference_number VARCHAR(255), -- UPI ID, bank reference, invoice number
    reason TEXT NOT NULL,
    notes TEXT,
    founder_name VARCHAR(100),
    to_founder VARCHAR(100),
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cash_ledger_account ON cash_ledger(cash_account_id);
CREATE INDEX IF NOT EXISTS idx_cash_ledger_source ON cash_ledger(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_cash_ledger_type_status ON cash_ledger(type, status);
CREATE INDEX IF NOT EXISTS idx_cash_ledger_date ON cash_ledger(date DESC);

-- 36. Monthly Financial Snapshots Table (Performance cache)
CREATE TABLE IF NOT EXISTS financial_monthly_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    snapshot_month DATE UNIQUE NOT NULL, -- first day of the month (e.g. 2026-07-01)
    revenue NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    cogs NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    gross_profit NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    operating_expenses NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    net_profit NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    inventory_value NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    cash_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 37. Supplier Payment Allocations Table
CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
    supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id) ON DELETE CASCADE,
    amount_allocated NUMERIC(12, 2) NOT NULL CHECK (amount_allocated > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sup_pay_alloc_pay ON supplier_payment_allocations(supplier_payment_id);
CREATE INDEX IF NOT EXISTS idx_sup_pay_alloc_purch ON supplier_payment_allocations(supplier_purchase_id);

-- 38. Supplier Credits Table
CREATE TABLE IF NOT EXISTS supplier_credits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    source_receipt_id UUID REFERENCES supplier_purchase_receipts(id) ON DELETE SET NULL,
    applied_payment_id UUID REFERENCES supplier_payments(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Available', -- 'Available', 'Applied', 'Refunded'
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sup_credits_supplier ON supplier_credits(supplier_id);

-- 39. Inventory Adjustments Table
CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity_changed INT NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'Write-off', 'Found', 'Correction', 'Damage'
    reason TEXT NOT NULL,
    requested_by VARCHAR(255) NOT NULL,
    approved_by VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'Pending', -- 'Pending', 'Approved', 'Rejected'
    approved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inv_adjustments_variant ON inventory_adjustments(variant_id);

-- 40. Customer Payments Table
CREATE TABLE IF NOT EXISTS customer_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(50) NOT NULL, -- 'Razorpay', 'UPI', 'Bank Transfer', 'Cash'
    transaction_reference VARCHAR(255) UNIQUE,
    reconciliation_status VARCHAR(50) NOT NULL DEFAULT 'Unreconciled', -- 'Unreconciled', 'Reconciled', 'Flagged'
    reconciled_at TIMESTAMP WITH TIME ZONE,
    reconciled_by VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cust_payments_order ON customer_payments(order_id);

-- 41. Customer Returns Table
CREATE TABLE IF NOT EXISTS customer_returns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    reason TEXT NOT NULL,
    action_taken VARCHAR(50) NOT NULL, -- 'Restocked', 'Written-off', 'Replacement Shipped'
    refunded_amount NUMERIC(12, 2) DEFAULT 0.00 CHECK (refunded_amount >= 0),
    received_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cust_returns_order ON customer_returns(order_id);
CREATE INDEX IF NOT EXISTS idx_cust_returns_variant ON customer_returns(variant_id);
