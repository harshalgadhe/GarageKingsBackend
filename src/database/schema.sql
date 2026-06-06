-- ============================================================================
-- GARAGEKINGS ENTERPRISE POSTGRESQL DATABASE SCHEMA (DDL)
-- Version 1.0 - Production Stack
-- ============================================================================

-- Enable UUID extension for secure, non-sequential resource identifiers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Custom Types
CREATE TYPE inventory_tx_type AS ENUM ('Added', 'Edited', 'Reserved', 'Sold', 'Returned', 'Cancelled', 'Deleted');
CREATE TYPE order_status AS ENUM ('Pending', 'Paid', 'Shipped', 'Delivered', 'Cancelled');
CREATE TYPE listing_status AS ENUM ('Active', 'Sold', 'Delisted');
CREATE TYPE offer_status AS ENUM ('Pending', 'Accepted', 'Declined', 'Withdrawn');
CREATE TYPE auction_status AS ENUM ('Upcoming', 'Active', 'Completed', 'Cancelled');

-- 1. Users Table (Core Auth mapped to AWS Cognito)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cognito_sub VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_users_cognito_sub ON users(cognito_sub);

-- 2. Profiles Table (Collector Identity & Reputation)
CREATE TABLE profiles (
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
CREATE INDEX idx_profiles_username ON profiles(username);

-- 3. Products Table (Master Castings Catalog)
CREATE TABLE products (
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_products_brand_model ON products(brand, model_name);
CREATE INDEX idx_products_sku ON products(sku);

-- 4. Product Images Table (Multi-resolution Assets Store)
CREATE TABLE product_images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    thumbnail_url TEXT NOT NULL,
    medium_url TEXT NOT NULL,
    full_url TEXT NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_product_images_parent ON product_images(product_id);

-- 5. Inventory Table (Quantities in Stock)
CREATE TABLE inventory (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID UNIQUE NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity_available INT NOT NULL DEFAULT 0 CONSTRAINT chk_qty_avail CHECK (quantity_available >= 0),
    quantity_reserved INT NOT NULL DEFAULT 0 CONSTRAINT chk_qty_res CHECK (quantity_reserved >= 0),
    warehouse_shelf_location VARCHAR(100),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Inventory Transactions Table (Mandatory Audit Logs)
CREATE TABLE inventory_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type inventory_tx_type NOT NULL,
    quantity_changed INT NOT NULL,
    reason TEXT NOT NULL,
    admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_inv_tx_prod_type ON inventory_transactions(product_id, type);

-- 7. Customers Table (CRM Record Tracks)
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) UNIQUE NOT NULL,
    instagram VARCHAR(100),
    address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_cust_phone_search ON customers(phone);
CREATE INDEX idx_cust_name_search ON customers(full_name);

-- 8. Receipts Table (In-person & Manual Billing)
CREATE TABLE receipts (
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_receipts_num ON receipts(receipt_number);
CREATE INDEX idx_receipts_customer ON receipts(customer_id);

-- 9. Receipt Items Table
CREATE TABLE receipt_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    qty INT NOT NULL DEFAULT 1 CHECK (qty > 0),
    amount NUMERIC(12, 2) NOT NULL
);
CREATE INDEX idx_receipt_items_parent ON receipt_items(receipt_id);

-- 10. Orders Table (E-commerce Purchases)
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status order_status DEFAULT 'Pending',
    total_price NUMERIC(12, 2) NOT NULL CONSTRAINT chk_order_total CHECK (total_price >= 0),
    shipping_address TEXT NOT NULL,
    tracking_number VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_orders_user ON orders(user_id);

-- 11. Order Items Table
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    qty INT NOT NULL DEFAULT 1 CHECK (qty > 0),
    price_at_purchase NUMERIC(12, 2) NOT NULL
);
CREATE INDEX idx_order_items_parent ON order_items(order_id);

-- 12. Wishlists Table
CREATE TABLE wishlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, product_id)
);
CREATE INDEX idx_wishlists_user ON wishlists(user_id);

-- 13. Garage Items Table (Collection Tracking)
CREATE TABLE garage_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    custom_nickname VARCHAR(100),
    purchase_price NUMERIC(12, 2),
    condition_grade VARCHAR(50) DEFAULT 'Card Mint',
    is_featured BOOLEAN DEFAULT FALSE,
    acquired_date DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_garage_user_search ON garage_items(user_id);
CREATE INDEX idx_garage_user_featured ON garage_items(user_id, is_featured);

-- 14. Garage Item Images Table (Collector Custom Photos)
CREATE TABLE garage_item_images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    garage_item_id UUID NOT NULL REFERENCES garage_items(id) ON DELETE CASCADE,
    thumbnail_url TEXT NOT NULL,
    full_url TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_garage_item_images_parent ON garage_item_images(garage_item_id);

-- 15. Drops Table (Timed Releases)
CREATE TABLE drops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
    description TEXT,
    label VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_drops_schedule ON drops(scheduled_time, is_active);

-- 16. Drop Products Table
CREATE TABLE drop_products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drop_id UUID NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    allocated_qty INT NOT NULL DEFAULT 1 CHECK (allocated_qty > 0),
    UNIQUE(drop_id, product_id)
);

-- 17. Notifications Table (System Messaging alerts)
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_notif_user_unread ON notifications(user_id, is_read);

-- 18. Marketplace Listings Table (Member Direct Listings)
CREATE TABLE marketplace_listings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    asking_price NUMERIC(12, 2) NOT NULL CONSTRAINT chk_ask CHECK (asking_price > 0),
    condition_grade VARCHAR(100) NOT NULL,
    status listing_status DEFAULT 'Active',
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_market_prod_status ON marketplace_listings(product_id, status);
CREATE INDEX idx_market_seller_status ON marketplace_listings(seller_id, status);

-- 19. Offers Table (Negotiations)
CREATE TABLE offers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offered_price NUMERIC(12, 2) NOT NULL CONSTRAINT chk_offer_price CHECK (offered_price > 0),
    status offer_status DEFAULT 'Pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_offers_listing ON offers(listing_id);
CREATE INDEX idx_offers_buyer ON offers(buyer_id);

-- 20. Watchlists Table (Saved Listings)
CREATE TABLE watchlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, listing_id)
);
CREATE INDEX idx_watchlists_user ON watchlists(user_id);

-- 21. Auction Events Table (Auction Management)
CREATE TABLE auction_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
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
CREATE INDEX idx_auction_status ON auction_events(status, start_time, end_time);
CREATE INDEX idx_auction_product ON auction_events(product_id);

-- 22. Auction Bids Table (Real-time Bidding Entries)
CREATE TABLE auction_bids (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id UUID NOT NULL REFERENCES auction_events(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CONSTRAINT chk_bid_amt CHECK (amount > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_auction_bids_amt ON auction_bids(auction_id, amount DESC);
CREATE INDEX idx_auction_bids_user ON auction_bids(user_id);

-- 23. Auction Winners Table (Auction Checkout Mapping)
CREATE TABLE auction_winners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id UUID UNIQUE NOT NULL REFERENCES auction_events(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    winning_bid_id UUID UNIQUE NOT NULL REFERENCES auction_bids(id) ON DELETE RESTRICT,
    checkout_order_id UUID UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 24. Admin Audit Logs Table (Mandatory Internal Logging System)
CREATE TABLE admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action VARCHAR(255) NOT NULL, -- e.g., 'UPDATE_INVENTORY', 'DELETE_PRODUCT'
    entity VARCHAR(100) NOT NULL, -- e.g., 'inventory', 'products'
    entity_id VARCHAR(100) NOT NULL,
    before_state JSONB,
    after_state JSONB,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_admin ON admin_audit_logs(admin_id, timestamp DESC);

-- Helper mapping table for firestore migrations
CREATE TABLE id_mappings (
    firestore_id VARCHAR(100) PRIMARY KEY,
    postgresql_id UUID NOT NULL,
    collection_name VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_id_mappings_ref ON id_mappings(collection_name, firestore_id);

-- Dead Letter Queue for dual-writes sync anomalies
CREATE TABLE dual_write_dlq (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    error_message TEXT NOT NULL,
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
