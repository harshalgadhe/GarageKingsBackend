import { Injectable, OnModuleInit, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { hashPassword, verifyPassword, localCache } from './api.helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isLambda = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT || process.env.LAMBDA_RUNTIME_DIR);
const privateUploadDir = isLambda
  ? '/tmp/storage/uploads'
  : path.join(__dirname, '..', '..', '..', 'storage', 'uploads');

@Injectable()
export class ApiService implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    // Ensure storage folder for secure private uploads exists
    try {
      if (!fs.existsSync(privateUploadDir)) {
        fs.mkdirSync(privateUploadDir, { recursive: true });
      }
    } catch (err: any) {
      console.warn(`[onModuleInit] Failed to create privateUploadDir: ${err.message}`);
    }

    // Dynamic schema validation & correction fallback (insulates against missed runs)
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS global_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Alter order_status enum values if they don't exist
    for (const val of ['Verification Pending', 'Confirmed', 'Reserved', 'Pre-Order', 'Awaiting Stock']) {
      try {
        await this.dataSource.query(`ALTER TYPE order_status ADD VALUE IF NOT EXISTS '${val}'`);
      } catch (err: any) {
        console.warn(`[onModuleInit] Did not add enum value '${val}': ${err.message}`);
      }
    }

    // Ensure all v2 database schema modifications are applied dynamically
    await this.dataSource.query(`
      -- 1. Users alterations
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'Viewer';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_token_hash VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE users ALTER COLUMN cognito_sub DROP NOT NULL;

      -- 2. Products alterations
      ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(12, 2) DEFAULT 0.00;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS selling_price NUMERIC(12, 2) DEFAULT 0.00;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS total_stock INT DEFAULT 10;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS locked_stock INT DEFAULT 0;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS sold_stock INT DEFAULT 0;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier VARCHAR(255);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS arrival_date DATE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS release_date DATE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Published';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS show_on_homepage BOOLEAN DEFAULT TRUE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_by VARCHAR(255);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS max_qty_per_customer INT DEFAULT NULL;

      -- 3. Orders alterations
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS screenshot_url TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255) UNIQUE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_partner VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC(12, 2) DEFAULT 0.00;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS packaging_cost NUMERIC(12, 2) DEFAULT 0.00;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_date TIMESTAMP WITH TIME ZONE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_date TIMESTAMP WITH TIME ZONE;

      -- 4. Customers alterations
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS instagram_username VARCHAR(100);
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255);
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS city VARCHAR(100);
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

      -- 5. Audit logs alterations
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS performed_by VARCHAR(255);
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(50);

      -- 6. Pre-order support columns on orders
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS booking_type VARCHAR(20) DEFAULT 'standard';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_amount NUMERIC(12, 2) DEFAULT 0.00;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC(12, 2) DEFAULT 0.00;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_screenshot_url TEXT;

      -- 7. Pre-booking support columns on products
      ALTER TABLE products ADD COLUMN IF NOT EXISTS is_prebook BOOLEAN DEFAULT FALSE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS prebook_deposit_amount NUMERIC(12, 2) DEFAULT NULL;
    `);

    // Migrate customers unique constraint: drop phone key, ensure email is the unique identifier
    await this.dataSource.query(`
      ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_phone_key;
      ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;
    `);
    await this.dataSource.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'customers_email_key' AND table_name = 'customers'
        ) THEN
          ALTER TABLE customers ADD CONSTRAINT customers_email_key UNIQUE (email);
        END IF;
      END
      $$;
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title VARCHAR(255) NOT NULL,
        amount NUMERIC(12, 2) NOT NULL,
        category VARCHAR(100) NOT NULL,
        paid_by VARCHAR(100) NOT NULL,
        date DATE NOT NULL,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS split_settlements (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        from_founder VARCHAR(100) NOT NULL,
        to_founder VARCHAR(100) NOT NULL,
        amount NUMERIC(12, 2) NOT NULL,
        notes TEXT,
        date DATE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        product_id UUID NOT NULL,
        customer_id UUID NOT NULL,
        order_id UUID,
        quantity INT DEFAULT 1,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        status VARCHAR(50) DEFAULT 'Active',
        idempotency_key VARCHAR(255) UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS system_notifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(50) DEFAULT 'info', -- 'low_stock', 'timer_alert', 'payment'
        order_id UUID DEFAULT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Ensure order_id column exists on older deployments
    await this.dataSource.query(`ALTER TABLE system_notifications ADD COLUMN IF NOT EXISTS order_id UUID DEFAULT NULL;`);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS homepage_sections (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        section_name VARCHAR(100) UNIQUE NOT NULL,
        is_visible BOOLEAN DEFAULT TRUE,
        display_order INT DEFAULT 0,
        metadata JSONB DEFAULT '{}'::JSONB
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS homepage_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        section_id UUID REFERENCES homepage_sections(id) ON DELETE CASCADE,
        product_id UUID REFERENCES products(id) ON DELETE CASCADE,
        is_visible BOOLEAN DEFAULT TRUE,
        display_order INT DEFAULT 0,
        UNIQUE(section_id, product_id)
      );
    `);

    await this.dataSource.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'distributors') AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'suppliers') THEN
          ALTER TABLE distributors RENAME TO suppliers;
        END IF;
      END$$;
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          name VARCHAR(255) UNIQUE NOT NULL,
          contact_email VARCHAR(255),
          contact_phone VARCHAR(50),
          address TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS supplier_purchases (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
          purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
          expected_arrival_date DATE,
          status VARCHAR(50) NOT NULL DEFAULT 'Draft',
          total_value NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS supplier_purchase_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id) ON DELETE CASCADE,
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
          quantity INT NOT NULL CHECK (quantity > 0),
          purchase_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS supplier_payments (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id) ON DELETE CASCADE,
          amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
          payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
          cash_account_id UUID NOT NULL REFERENCES cash_accounts(id) ON DELETE RESTRICT,
          payment_method VARCHAR(50) NOT NULL,
          reference_number VARCHAR(255),
          notes TEXT,
          created_by VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS supplier_purchase_receipts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id) ON DELETE RESTRICT,
          receipt_number VARCHAR(100) UNIQUE NOT NULL,
          received_date DATE NOT NULL DEFAULT CURRENT_DATE,
          received_by VARCHAR(255) NOT NULL,
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS supplier_purchase_receipt_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          purchase_receipt_id UUID NOT NULL REFERENCES supplier_purchase_receipts(id) ON DELETE CASCADE,
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
          quantity_received INT NOT NULL CHECK (quantity_received >= 0),
          quantity_short INT NOT NULL DEFAULT 0 CHECK (quantity_short >= 0),
          quantity_damaged INT NOT NULL DEFAULT 0 CHECK (quantity_damaged >= 0),
          quantity_over INT NOT NULL DEFAULT 0 CHECK (quantity_over >= 0),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS supplier_purchase_attachments (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          supplier_purchase_id UUID REFERENCES supplier_purchases(id) ON DELETE CASCADE,
          purchase_receipt_id UUID REFERENCES supplier_purchase_receipts(id) ON DELETE CASCADE,
          file_name VARCHAR(255) NOT NULL,
          file_path VARCHAR(512) NOT NULL,
          uploaded_by VARCHAR(255) NOT NULL,
          uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.dataSource.query(`
      -- Alter inventory_batches to add supplier_purchase_id and purchase_receipt_id
      ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
      ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS supplier_purchase_id UUID REFERENCES supplier_purchases(id) ON DELETE SET NULL;
      ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS purchase_receipt_id UUID REFERENCES supplier_purchase_receipts(id) ON DELETE SET NULL;
    `);

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        source VARCHAR(50) NOT NULL,
        level VARCHAR(20) DEFAULT 'error',
        message TEXT NOT NULL,
        stack TEXT,
        url VARCHAR(512),
        user_agent VARCHAR(512),
        user_email VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Bootstrap default CMS sections if empty
    const secCount = await this.dataSource.query("SELECT COUNT(*) FROM homepage_sections");
    if (Number(secCount[0].count) === 0) {
      await this.dataSource.query(`
        INSERT INTO homepage_sections (section_name, is_visible, display_order)
        VALUES 
          ('Hero', true, 1),
          ('This Week''s Drop', true, 2),
          ('Marketplace Preview', true, 3),
          ('Verified Collectibles', true, 4)
      `);
    }

    // Run Startup Automated Integrity Reconciliation Check
    this.runInventoryReconciliation('Startup Automated Check').catch(err => {
      console.error("[Inventory] Startup reconciliation failed:", err);
    });

    // Schedule Nightly Automated Reconciliation Check at 2:00 AM
    const runNightlyReconcile = async () => {
      try {
        await this.runInventoryReconciliation('Nightly Automated Scheduler');
      } catch (err) {
        console.error("[Worker Error] Failed executing nightly reconciliation:", err);
      }
    };
    const now = new Date();
    const target = new Date();
    target.setHours(2, 0, 0, 0);
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    const msUntilTarget = target.getTime() - now.getTime();
    setTimeout(() => {
      runNightlyReconcile();
      setInterval(runNightlyReconcile, 24 * 60 * 60 * 1000);
    }, msUntilTarget);
  }

  // ── AUDIT LOGGING SYSTEM (IMMUTABLE LOGS) ──────────────────────────
  async writeAuditLog(action: string, entity: string, entityId: string, performedBy: string, ipAddress: string, before: any, after: any) {
    try {
      await this.dataSource.query(`
        INSERT INTO audit_logs (action, entity, entity_id, performed_by, ip_address, before_state, after_state, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());
      `, [
        action,
        entity,
        entityId,
        performedBy || 'System/Guest',
        ipAddress || '127.0.0.1',
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null
      ]);
    } catch (err) {
      console.error("Audit log insertion failed:", err);
    }
  }

  // ── AUTHENTICATION & RBAC SERVICES ─────────────────────────────────
  async getSetupStatus() {
    const rows = await this.dataSource.query("SELECT id FROM users WHERE role = 'Owner' LIMIT 1;");
    return { isSetupRequired: rows.length === 0 };
  }

  async setupOwner(dto: any) {
    const status = await this.getSetupStatus();
    if (!status.isSetupRequired) {
      throw new UnauthorizedException("First startup owner setup is disabled. Setup has already run.");
    }
    const hash = hashPassword(dto.password);
    const result = await this.dataSource.query(`
      INSERT INTO users (email, password_hash, role)
      VALUES ($1, $2, 'Owner')
      RETURNING id, email, role;
    `, [dto.email.trim().toLowerCase(), hash]);
    return result[0];
  }

  async registerUser(email: string, pass: string, fullName?: string) {
    const emailClean = email.trim().toLowerCase();
    const existing = await this.dataSource.query("SELECT id FROM users WHERE email = $1", [emailClean]);
    if (existing.length > 0) {
      throw new BadRequestException('Email address already registered.');
    }
    const hash = hashPassword(pass);
    const targetRole = emailClean === 'harshalgadhe123@gmail.com' ? 'Owner' : 'Collector';
    const result = await this.dataSource.query(`
      INSERT INTO users (email, password_hash, role)
      VALUES ($1, $2, $3)
      RETURNING id, email, role;
    `, [emailClean, hash, targetRole]);
    return result[0];
  }

  async validateUserCredentials(email: string, pass: string) {
    const emailClean = email.trim().toLowerCase();
    const rows = await this.dataSource.query("SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL", [emailClean]);
    if (rows.length === 0) return null;
    
    const user = rows[0];
    if (verifyPassword(pass, user.password_hash)) {
      let role = user.role;
      if (emailClean === 'harshalgadhe123@gmail.com' && role !== 'Owner') {
        role = 'Owner';
        await this.dataSource.query("UPDATE users SET role = 'Owner' WHERE id = $1", [user.id]);
      }
      return { id: user.id, email: user.email, role };
    }
    return null;
  }

  async syncGoogleUser(email: string, pass: string) {
    const hash = hashPassword(pass);
    const emailClean = email.trim().toLowerCase();
    const existing = await this.dataSource.query("SELECT id, role, password_hash FROM users WHERE email = $1", [emailClean]);
    
    const targetRole = emailClean === 'harshalgadhe123@gmail.com' ? 'Owner' : 'Collector';
    
    if (existing.length > 0) {
      await this.dataSource.query("UPDATE users SET password_hash = $1, role = CASE WHEN email = 'harshalgadhe123@gmail.com' THEN 'Owner' ELSE role END WHERE email = $2", [hash, emailClean]);
      return { id: existing[0].id, email: emailClean, role: emailClean === 'harshalgadhe123@gmail.com' ? 'Owner' : existing[0].role };
    } else {
      const result = await this.dataSource.query(`
        INSERT INTO users (email, password_hash, role)
        VALUES ($1, $2, $3)
        RETURNING id, email, role;
      `, [emailClean, hash, targetRole]);
      return result[0];
    }
  }

  async getUserById(id: string) {
    const rows = await this.dataSource.query("SELECT id, email, role FROM users WHERE id = $1 AND deleted_at IS NULL", [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  async updateRefreshToken(userId: string, token: string | null) {
    const hash = token ? crypto.createHash('sha256').update(token).digest('hex') : null;
    await this.dataSource.query("UPDATE users SET refresh_token_hash = $1 WHERE id = $2", [hash, userId]);
  }

  async verifyRefreshToken(userId: string, token: string) {
    const rows = await this.dataSource.query("SELECT refresh_token_hash FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
    if (rows.length === 0 || !rows[0].refresh_token_hash) return false;
    const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
    return expectedHash === rows[0].refresh_token_hash;
  }

  // ── INVENTORY MODULE ───────────────────────────────────────────────
  async getProducts(adminMode = false) {
    const cacheKey = `products_list_${adminMode}`;
    const cached = localCache.get(cacheKey);
    if (cached) return cached;

    const adminFields = adminMode ? `
      p.purchase_price as "purchasePrice",
      p.total_stock as "totalStock",
      p.locked_stock as "lockedStock",
      p.sold_stock as "soldStock",
      p.supplier,
      p.created_by as "createdBy",
      p.updated_by as "updatedBy",
    ` : '';

    let queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.selling_price as "sellingPrice",
             ${adminFields}
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             p.is_prebook as "isPrebook", p.prebook_deposit_amount as "prebookDepositAmount",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL
    `;

    if (!adminMode) {
      queryStr += " AND p.status = 'Published'";
    }

    queryStr += " ORDER BY p.created_at DESC;";

    const rows = await this.dataSource.query(queryStr);
    localCache.set(cacheKey, rows, 10); // Cache lists for 10 seconds (Redis simulation)
    return rows;
  }

  async getPaginatedProducts(options: {
    page?: number;
    limit?: number;
    brand?: string;
    scale?: string;
    tag?: string;
    search?: string;
    inStock?: boolean;
    preBooking?: boolean;
    adminMode?: boolean;
  }) {
    const page = Math.max(1, Number(options.page || 1));
    const limit = Math.max(1, Math.min(100, Number(options.limit || 12)));
    const offset = (page - 1) * limit;

    const adminFields = options.adminMode ? `
      p.purchase_price as "purchasePrice",
      p.total_stock as "totalStock",
      p.locked_stock as "lockedStock",
      p.sold_stock as "soldStock",
      p.supplier,
      p.created_by as "createdBy",
      p.updated_by as "updatedBy",
    ` : '';

    let queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.selling_price as "sellingPrice",
             ${adminFields}
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             p.is_prebook as "isPrebook", p.prebook_deposit_amount as "prebookDepositAmount",
             p.casing_types as "casingTypes",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL
    `;

    if (!options.adminMode) {
      queryStr += ` AND p.status = 'Published'`;
    }


    const params: any[] = [];
    let paramIndex = 1;

    if (options.brand) {
      queryStr += ` AND LOWER(p.brand) = LOWER($${paramIndex})`;
      params.push(options.brand);
      paramIndex++;
    }

    if (options.scale) {
      queryStr += ` AND p.scale = $${paramIndex}`;
      params.push(options.scale);
      paramIndex++;
    }

    if (options.tag) {
      queryStr += ` AND $${paramIndex} = ANY(p.tags)`;
      params.push(options.tag);
      paramIndex++;
    }

    if (options.inStock) {
      queryStr += ` AND (p.total_stock - p.locked_stock - p.sold_stock) > 0`;
    }

    if (options.preBooking) {
      queryStr += ` AND (p.is_prebook = true OR 'Pre-Order' = ANY(p.tags) OR 'Pre Booking' = ANY(p.tags) OR (p.release_date IS NOT NULL AND p.release_date > CURRENT_DATE))`;
    }

    if (options.search) {
      queryStr += ` AND (
        LOWER(p.model_name) LIKE LOWER($${paramIndex}) OR
        LOWER(p.brand) LIKE LOWER($${paramIndex}) OR
        LOWER(p.series) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    // Clone query for count
    const countQuery = `SELECT COUNT(*)::int as total FROM (${queryStr}) as sub`;
    const countRows = await this.dataSource.query(countQuery, params);
    const total = parseInt(countRows[0]?.total || '0', 10);

    // Add ordering and pagination
    queryStr += ` ORDER BY p.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const rows = await this.dataSource.query(queryStr, params);

    return {
      products: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async getProduct(id: string, adminMode = false) {
    const cacheKey = `product_${id}_${adminMode}`;
    const cached = localCache.get(cacheKey);
    if (cached) return cached;

    const adminFields = adminMode ? `
      p.purchase_price as "purchasePrice",
      p.total_stock as "totalStock",
      p.locked_stock as "lockedStock",
      p.sold_stock as "soldStock",
      p.supplier,
      p.created_by as "createdBy",
      p.updated_by as "updatedBy",
    ` : '';

    const queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.selling_price as "sellingPrice",
             ${adminFields}
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             p.is_prebook as "isPrebook", p.prebook_deposit_amount as "prebookDepositAmount",
             p.casing_types as "casingTypes",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL AND p.id = $1
      LIMIT 1;
    `;

    const rows = await this.dataSource.query(queryStr, [id]);
    if (rows.length === 0) return null;
    const product = rows[0];

    const casings = await this.dataSource.query(`
      SELECT casing_type as "casingType", 
             MAX(selling_price)::float as "price",
             SUM(quantity_available)::int as "availableStock"
      FROM inventory_batches
      WHERE product_id = $1 AND status = 'Open' AND quantity_available > 0
      GROUP BY casing_type
      ORDER BY price ASC;
    `, [id]);

    product.availableCasings = casings;

    localCache.set(cacheKey, product, 10); // Cache single item for 10 seconds
    return product;
  }

  async addProduct(car: any, creatorEmail: string, ipAddress: string) {
    const sku = car.sku || `SKU-${Date.now()}`;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const prodRes = await queryRunner.query(`
        INSERT INTO products (sku, brand, model_name, series, scale, rarity_level, base_price, description, tags, category, purchase_price, selling_price, total_stock, supplier, arrival_date, release_date, status, show_on_homepage, created_by, max_qty_per_customer, is_prebook, prebook_deposit_amount, casing_types)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, 0, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        RETURNING id;
      `, [
        sku,
        car.brand || 'MINI GT',
        car.name || 'Unknown Casting',
        car.series || 'Collector Series',
        car.scale || '1:64',
        car.lane || 'Standard Edition',
        Number(car.price || 0),
        car.description || '',
        car.tags || [],
        car.category || 'JDM',
        Number(car.price || 0),
        car.supplier || '',
        car.arrivalDate || null,
        car.releaseDate || null,
        car.status || 'Published',
        car.showOnHomepage !== false,
        creatorEmail,
        car.maxQtyPerCustomer !== undefined && car.maxQtyPerCustomer !== null && car.maxQtyPerCustomer !== '' ? Number(car.maxQtyPerCustomer) : null,
        car.isPrebook === true,
        car.prebookDepositAmount !== undefined && car.prebookDepositAmount !== null && car.prebookDepositAmount !== '' ? Number(car.prebookDepositAmount) : null,
        car.casingTypes || ['box']
      ]);

      const productId = prodRes[0].id;

      if (car.image) {
        await queryRunner.query(`
          INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
          VALUES ($1, $2, $3, $4, true);
        `, [productId, car.image, car.image, car.image]);
      }

      await queryRunner.query(`
        INSERT INTO inventory (product_id, quantity_available, quantity_reserved, quantity_sold, quantity_returned, quantity_damaged, quantity_locked)
        VALUES ($1, 0, 0, 0, 0, 0, 0)
        ON CONFLICT (product_id) DO NOTHING;
      `, [productId]);

      const initialStock = Number(car.totalStock || 0);
      if (initialStock > 0) {
        await this.receiveInventoryBatchTx(
          queryRunner,
          productId,
          car.supplier || 'Default Supplier',
          Number(car.purchasePrice || 0),
          Number(car.price || 0),
          initialStock,
          creatorEmail,
          ipAddress
        );
      }

      // Low stock check trigger
      if (initialStock <= 3) {
        await this.createSystemNotification(
          'Low Stock Alert',
          `Casting "${car.name}" has critical stock count: ${initialStock}`,
          'low_stock'
        );
      }

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      // Log audit trace
      await this.writeAuditLog('CREATE_PRODUCT', 'products', productId, creatorEmail, ipAddress, null, car);

      return { id: productId, sku };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async updateProduct(id: string, car: any, updaterEmail: string, ipAddress: string) {
    const oldRes = await this.dataSource.query("SELECT * FROM products WHERE id = $1", [id]);
    const oldData = oldRes[0];

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const batchCountRes = await queryRunner.query("SELECT COUNT(*)::int as count FROM inventory_batches WHERE product_id = $1;", [id]);
      const hasBatches = batchCountRes[0].count > 0;

      if (hasBatches) {
        // Update product attributes including prices and metadata
        await queryRunner.query(`
          UPDATE products 
          SET brand = $1, model_name = $2, series = $3, scale = $4, rarity_level = $5, base_price = $6, description = $7, tags = $8,
              category = $9, purchase_price = $10, selling_price = $11, status = $12, show_on_homepage = $13, updated_by = $14, 
              max_qty_per_customer = $15, is_prebook = $16, prebook_deposit_amount = $17, availability_state = $18, casing_types = $19, updated_at = NOW()
          WHERE id = $20;
        `, [
          car.brand || oldData.brand,
          car.name || oldData.model_name,
          car.series !== undefined ? car.series : oldData.series,
          car.scale || oldData.scale,
          car.lane || oldData.rarity_level,
          Number(car.price || oldData.base_price),
          car.description !== undefined ? car.description : oldData.description,
          car.tags || oldData.tags,
          car.category || oldData.category,
          Number(car.purchasePrice || oldData.purchase_price),
          Number(car.price || oldData.selling_price),
          car.status || oldData.status,
          car.showOnHomepage !== false,
          updaterEmail,
          car.maxQtyPerCustomer !== undefined && car.maxQtyPerCustomer !== null && car.maxQtyPerCustomer !== '' ? Number(car.maxQtyPerCustomer) : oldData.max_qty_per_customer,
          car.isPrebook === true,
          car.prebookDepositAmount !== undefined && car.prebookDepositAmount !== null && car.prebookDepositAmount !== '' ? Number(car.prebookDepositAmount) : oldData.prebook_deposit_amount,
          car.availabilityState || oldData.availability_state || 'Available',
          car.casingTypes || oldData.casing_types || ['box'],
          id
        ]);
        
        // Handle stock level changes dynamically via ledger/batches
        const newStock = car.totalStock !== undefined ? Number(car.totalStock) : Number(oldData.total_stock);
        const diff = newStock - Number(oldData.total_stock);
        if (diff !== 0) {
          const latestBatchRes = await queryRunner.query(`
            SELECT * FROM inventory_batches 
            WHERE product_id = $1 
            ORDER BY received_at DESC, id DESC 
            LIMIT 1;
          `, [id]);
          
          if (latestBatchRes.length > 0) {
            const batch = latestBatchRes[0];
            const batchId = batch.id;
            const type = diff > 0 ? 'ADJUST_ADD' : 'ADJUST_REMOVE';
            const absDiff = Math.abs(diff);
            
            let newAvail = Number(batch.quantity_available);
            if (type === 'ADJUST_ADD') {
              newAvail += absDiff;
            } else {
              newAvail = Math.max(0, newAvail - absDiff);
            }
            
            await queryRunner.query(`
              UPDATE inventory_batches
              SET quantity_available = $1,
                  status = CASE WHEN $1 = 0 AND quantity_reserved = 0 THEN 'Fully Consumed'::VARCHAR ELSE status END,
                  updated_at = NOW()
              WHERE id = $2;
            `, [newAvail, batchId]);
            
            await queryRunner.query(`
              INSERT INTO inventory_ledger (product_id, batch_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
            `, [id, batchId, type, diff, Number(batch.purchase_price), Number(batch.selling_price), `Product edit stock adjustment from ${oldData.total_stock} to ${newStock}`, updaterEmail]);
            
            await queryRunner.query(`
              UPDATE products
              SET total_stock = total_stock + $1,
                  updated_at = NOW()
              WHERE id = $2;
            `, [diff, id]);

            await queryRunner.query(`
              UPDATE inventory
              SET quantity_available = quantity_available + $1,
                  updated_at = NOW()
              WHERE product_id = $2;
            `, [diff, id]);
          }
        }
      } else {
        // No batches exist yet: allow updating everything, and create default batch if totalStock changes
        await queryRunner.query(`
          UPDATE products 
          SET brand = $1, model_name = $2, series = $3, scale = $4, rarity_level = $5, base_price = $6, description = $7, tags = $8,
              category = $9, purchase_price = $10, selling_price = $11, total_stock = $12, supplier = $13,
              arrival_date = $14, release_date = $15, status = $16, show_on_homepage = $17, updated_by = $18, 
              max_qty_per_customer = $19, is_prebook = $20, prebook_deposit_amount = $21, availability_state = $22, casing_types = $23, updated_at = NOW()
          WHERE id = $24;
        `, [
          car.brand || oldData.brand,
          car.name || oldData.model_name,
          car.series !== undefined ? car.series : oldData.series,
          car.scale || oldData.scale,
          car.lane || oldData.rarity_level,
          Number(car.price || oldData.base_price),
          car.description !== undefined ? car.description : oldData.description,
          car.tags || oldData.tags,
          car.category || oldData.category,
          Number(car.purchasePrice || oldData.purchase_price),
          Number(car.price || oldData.selling_price),
          Number(car.totalStock || oldData.total_stock),
          car.supplier || oldData.supplier,
          car.arrivalDate || oldData.arrival_date,
          car.releaseDate || oldData.release_date,
          car.status || oldData.status,
          car.showOnHomepage !== false,
          updaterEmail,
          car.maxQtyPerCustomer !== undefined && car.maxQtyPerCustomer !== null && car.maxQtyPerCustomer !== '' ? Number(car.maxQtyPerCustomer) : oldData.max_qty_per_customer,
          car.isPrebook === true,
          car.prebookDepositAmount !== undefined && car.prebookDepositAmount !== null && car.prebookDepositAmount !== '' ? Number(car.prebookDepositAmount) : oldData.prebook_deposit_amount,
          car.availabilityState || oldData.availability_state || 'Available',
          car.casingTypes || oldData.casing_types || ['box'],
          id
        ]);

        const initialStock = Number(car.totalStock || 0);
        if (initialStock > 0) {
          await this.receiveInventoryBatchTx(
            queryRunner,
            id,
            car.supplier || 'Default Supplier',
            Number(car.purchasePrice || 0),
            Number(car.price || 0),
            initialStock,
            updaterEmail,
            ipAddress
          );
        }
      }

      const invRows = await queryRunner.query("SELECT quantity_available, quantity_reserved FROM inventory WHERE product_id = $1;", [id]);
      const currentAvailable = invRows[0]?.quantity_available || 0;

      // Trigger low stock notifications
      if (currentAvailable <= 3) {
        await this.createSystemNotification(
          'Low Stock Alert',
          `Casting "${car.name || oldData.model_name}" has critical stock count: ${currentAvailable}`,
          'low_stock'
        );
      }

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      // Log audit trace
      await this.writeAuditLog(
        'UPDATE_PRODUCT',
        'products',
        id,
        updaterEmail,
        ipAddress,
        oldData,
        car
      );

      return { success: true };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async softDeleteProduct(id: string, deleterEmail: string, ipAddress: string) {
    const oldRes = await this.dataSource.query("SELECT * FROM products WHERE id = $1", [id]);
    await this.dataSource.query("UPDATE products SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1;", [id]);
    localCache.del('products_list_true');
    localCache.del('products_list_false');
    await this.writeAuditLog('DELETE_PRODUCT', 'products', id, deleterEmail, ipAddress, oldRes[0], { deleted: true });
    return { success: true };
  }

  async restoreProduct(id: string, updaterEmail: string, ipAddress: string) {
    await this.dataSource.query("UPDATE products SET deleted_at = NULL, updated_at = NOW() WHERE id = $1;", [id]);
    localCache.del('products_list_true');
    localCache.del('products_list_false');
    await this.writeAuditLog('RESTORE_PRODUCT', 'products', id, updaterEmail, ipAddress, { deleted: true }, { restored: true });
    return { success: true };
  }

  // ── ATOMIC TRANSACTIONAL STOCK LOCKING (RESERVATIONS - DIRECT ORDER TRANSITION) ──
  async reserveProduct(dto: any, ipAddress: string, authenticatedUserId?: string) {
    const { productId, email, name, instagram, phone, address, idempotencyKey, bookingType, advanceAmount } = dto;
    const requestedQty = Math.max(1, Math.min(10, parseInt(dto.qty || dto.quantity || '1', 10)));
    const isPreOrder = bookingType === 'pre_order';

    if (!idempotencyKey) {
      throw new Error("Idempotency key is required to create order safely.");
    }

    // 1. Enforce Idempotency Lock Check
    const cachedRes = localCache.get(`idem_${idempotencyKey}`);
    if (cachedRes) return cachedRes;

    const dbIdem = await this.dataSource.query("SELECT id FROM orders WHERE idempotency_key = $1", [idempotencyKey]);
    if (dbIdem.length > 0) {
      return {
        success: true,
        orderId: dbIdem[0].id
      };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 2. Row-level lock target product to prevent race condition double-buys
      const prodRows = await queryRunner.query(`
        SELECT id, model_name as name, total_stock, locked_stock, sold_stock, max_qty_per_customer 
        FROM products 
        WHERE id = $1 AND deleted_at IS NULL 
        FOR UPDATE;
      `, [productId]);

      if (prodRows.length === 0) {
        throw new BadRequestException("Target die-cast grail does not exist or has been archived.");
      }

      const p = prodRows[0];
      // Accurate available stock = total - locked (pending orders) - sold
      const available = Number(p.total_stock) - Number(p.locked_stock || 0) - Number(p.sold_stock);

      if (available <= 0) {
        throw new BadRequestException(`Casting "${p.name}" is sold out.`);
      }

      if (requestedQty > available) {
        throw new BadRequestException(`Only ${available} unit(s) of "${p.name}" are available. You requested ${requestedQty}.`);
      }

      // Check customer purchase limit
      if (p.max_qty_per_customer !== null && p.max_qty_per_customer > 0) {
        const existingCountRes = await queryRunner.query(`
          SELECT COALESCE(SUM(oi.qty), 0) as total
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          JOIN users u ON u.id = o.user_id
          WHERE oi.product_id = $1 
            AND u.email = $2 
            AND o.status NOT IN ('Cancelled', 'Expired');
        `, [productId, email.trim().toLowerCase()]);
        const existingCount = Number(existingCountRes[0].total);
        if (existingCount + requestedQty > p.max_qty_per_customer) {
          throw new BadRequestException(`Purchase limit exceeded. You have already ordered/reserved ${existingCount} item(s) of this product. Maximum allowed per customer: ${p.max_qty_per_customer}.`);
        }
      }

      // 3. Get/create customer record
      const custRes = await queryRunner.query(`
        INSERT INTO customers (full_name, phone, instagram, address, email, city)
        VALUES ($1, $2, $3, $4, $5, 'Unknown')
        ON CONFLICT (email) DO UPDATE 
        SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, instagram = EXCLUDED.instagram, address = EXCLUDED.address
        RETURNING id;
      `, [name, phone, instagram, address, email.trim().toLowerCase()]);
      const customerId = custRes[0].id;

      // 4. Resolve user ID — prefer authenticated user, fall back to email upsert for guest checkout
      let userId: string;
      if (authenticatedUserId) {
        // Authenticated user: use their verified user ID directly, no upsert needed
        userId = authenticatedUserId;
      } else {
        const userRes = await queryRunner.query(`
          INSERT INTO users (email, cognito_sub)
          VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
          RETURNING id;
        `, [email.trim().toLowerCase(), `guest_${customerId}`]);
        userId = userRes[0].id;
      }

      // 5. Create parent Pending order record with idempotency
      const unitPrice = Number(dto.price || 0);
      const fullPrice = unitPrice * requestedQty;
      const advPaid = isPreOrder ? Math.min(Number(advanceAmount || 0), fullPrice) : fullPrice;
      const remaining = isPreOrder ? fullPrice - advPaid : 0;
      const orderStatus = isPreOrder ? 'Pre-Order' : 'Pending';
      const orderRes = await queryRunner.query(`
        INSERT INTO orders (user_id, total_price, shipping_address, status, booking_type, advance_amount, remaining_amount, created_at, updated_at, idempotency_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8)
        RETURNING id;
      `, [userId, fullPrice, `${address} | Insta: ${instagram} | Phone: ${phone}`, orderStatus, isPreOrder ? 'pre_order' : 'standard', advPaid, remaining, idempotencyKey]);
      const orderId = orderRes[0].id;

      // 6. Create order item with actual requested qty
      await queryRunner.query(`
        INSERT INTO order_items (order_id, product_id, qty, price_at_purchase)
        VALUES ($1, $2, $3, $4);
      `, [orderId, productId, requestedQty, unitPrice]);

      // 7. Lock the stock (increment locked_stock)
      await queryRunner.query(`
        UPDATE products SET locked_stock = COALESCE(locked_stock, 0) + $1, updated_at = NOW() WHERE id = $2;
      `, [requestedQty, productId]);

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      const responseObj = {
        success: true,
        orderId,
        bookingType: isPreOrder ? 'pre_order' : 'standard',
        advanceAmount: advPaid,
        remainingAmount: remaining
      };

      // Set idempotency cache
      localCache.set(`idem_${idempotencyKey}`, responseObj, 3600); // Lock key cache for 1 hour

      await this.writeAuditLog(
        'ORDER_CREATED',
        'orders',
        orderId,
        email,
        ipAddress,
        null,
        responseObj
      );

      return responseObj;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async reserveProductsCart(dto: any, ipAddress: string, authenticatedUserId?: string) {
    const { items, email, name, instagram, phone, address, idempotencyKey, bookingType, advanceAmount } = dto;
    const isPreOrder = bookingType === 'pre_order';

    if (!idempotencyKey) {
      throw new BadRequestException("Idempotency key is required to create order safely.");
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestException("Cart items are required to checkout.");
    }

    // 1. Enforce Idempotency Lock Check
    const cachedRes = localCache.get(`idem_${idempotencyKey}`);
    if (cachedRes) return cachedRes;

    const dbIdem = await this.dataSource.query("SELECT id FROM orders WHERE idempotency_key = $1", [idempotencyKey]);
    if (dbIdem.length > 0) {
      return {
        success: true,
        orderId: dbIdem[0].id
      };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 2. Get/create customer record
      const custRes = await queryRunner.query(`
        INSERT INTO customers (full_name, phone, instagram, address, email, city)
        VALUES ($1, $2, $3, $4, $5, 'Unknown')
        ON CONFLICT (email) DO UPDATE 
        SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, instagram = EXCLUDED.instagram, address = EXCLUDED.address
        RETURNING id;
      `, [name, phone, instagram, address, email.trim().toLowerCase()]);
      const customerId = custRes[0].id;

      // 3. Resolve user ID — prefer authenticated user, fall back to email upsert for guest checkout
      let userId: string;
      if (authenticatedUserId) {
        userId = authenticatedUserId;
      } else {
        const userRes = await queryRunner.query(`
          INSERT INTO users (email, cognito_sub)
          VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
          RETURNING id;
        `, [email.trim().toLowerCase(), `guest_${customerId}`]);
        userId = userRes[0].id;
      }

      // Compute total price of the aggregated cart
      let totalPrice = 0;
      for (const item of items) {
        totalPrice += Number(item.price || 0);
      }

      // 4. Create parent Pending order record with idempotency
      const advPaid = isPreOrder ? Math.min(Number(advanceAmount || 0), totalPrice) : totalPrice;
      const remaining = isPreOrder ? totalPrice - advPaid : 0;
      const orderStatus = isPreOrder ? 'Pre-Order' : 'Pending';
      const orderRes = await queryRunner.query(`
        INSERT INTO orders (user_id, total_price, shipping_address, status, booking_type, advance_amount, remaining_amount, created_at, updated_at, idempotency_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8)
        RETURNING id;
      `, [userId, totalPrice, `${address} | Insta: ${instagram} | Phone: ${phone}`, orderStatus, isPreOrder ? 'pre_order' : 'standard', advPaid, remaining, idempotencyKey]);
      const orderId = orderRes[0].id;

      // Calculate quantities requested for each product in the cart
      const requestedQuantities: Record<string, number> = {};
      for (const item of items) {
        requestedQuantities[item.productId] = (requestedQuantities[item.productId] || 0) + 1;
      }

      // Build a map of unique products to their price for processing
      const uniqueProductPrices: Record<string, number> = {};
      for (const item of items) {
        if (!(item.productId in uniqueProductPrices)) {
          uniqueProductPrices[item.productId] = Number(item.price || 0);
        }
      }

      // Process each unique product: validate stock, insert order_item, lock stock
      for (const [productId, qtyNeeded] of Object.entries(requestedQuantities)) {
        const unitPrice = uniqueProductPrices[productId] || 0;

        // Row-level lock target product
        const prodRows = await queryRunner.query(`
          SELECT id, model_name as name, total_stock, locked_stock, sold_stock, max_qty_per_customer 
          FROM products 
          WHERE id = $1 AND deleted_at IS NULL 
          FOR UPDATE;
        `, [productId]);

        if (prodRows.length === 0) {
          throw new BadRequestException("Target die-cast grail does not exist or has been archived.");
        }

        const p = prodRows[0];
        // Accurate available stock = total - locked (pending orders) - sold
        const available = Number(p.total_stock) - Number(p.locked_stock || 0) - Number(p.sold_stock);

        if (available <= 0) {
          throw new BadRequestException(`Casting "${p.name}" is sold out.`);
        }

        if (qtyNeeded > available) {
          throw new BadRequestException(`Only ${available} unit(s) of "${p.name}" are available. You requested ${qtyNeeded}.`);
        }

        // Check customer purchase limit
        if (p.max_qty_per_customer !== null && p.max_qty_per_customer > 0) {
          const existingCountRes = await queryRunner.query(`
            SELECT COALESCE(SUM(oi.qty), 0) as total
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN users u ON u.id = o.user_id
            WHERE oi.product_id = $1 
              AND u.email = $2 
              AND o.status NOT IN ('Cancelled', 'Expired');
          `, [productId, email.trim().toLowerCase()]);
          const existingCount = Number(existingCountRes[0].total);
          if (existingCount + qtyNeeded > p.max_qty_per_customer) {
            throw new BadRequestException(`Purchase limit exceeded for "${p.name}". You are trying to order ${qtyNeeded} item(s), but you have already ordered/reserved ${existingCount}. Maximum allowed per customer: ${p.max_qty_per_customer}.`);
          }
        }

        // Create order item with correct qty
        await queryRunner.query(`
          INSERT INTO order_items (order_id, product_id, qty, price_at_purchase)
          VALUES ($1, $2, $3, $4);
        `, [orderId, productId, qtyNeeded, unitPrice]);

        // Lock the stock
        await queryRunner.query(`
          UPDATE products SET locked_stock = COALESCE(locked_stock, 0) + $1, updated_at = NOW() WHERE id = $2;
        `, [qtyNeeded, productId]);
      }

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      const responseObj = {
        success: true,
        orderId,
        bookingType: isPreOrder ? 'pre_order' : 'standard',
        advanceAmount: advPaid,
        remainingAmount: remaining
      };

      // Set idempotency cache
      localCache.set(`idem_${idempotencyKey}`, responseObj, 3600);

      await this.writeAuditLog(
        'ORDER_CREATED_CART',
        'orders',
        orderId,
        email,
        ipAddress,
        null,
        responseObj
      );

      return responseObj;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  // ── UPI SCREENSHOT UPLOAD SECURE STRATEGY ──────────────────────────
  async saveScreenshotReceipt(orderId: string, fileBuffer: Buffer, fileExtension: string, userId: string, ipAddress: string) {
    const orderRows = await this.dataSource.query(
      "SELECT id, user_id, status FROM orders WHERE id = $1 AND deleted_at IS NULL",
      [orderId]
    );
    if (orderRows.length === 0) throw new BadRequestException('Order not found.');
    const order = orderRows[0];
    if (order.user_id !== userId) {
      throw new UnauthorizedException('You do not have permission to upload screenshot for this order.');
    }

    const fileName = `${crypto.randomUUID()}.${fileExtension}`;
    
    if (process.env.S3_ASSETS_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET,
          Key: `uploads/${fileName}`,
          Body: fileBuffer,
          ContentType: `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`
        }));
        console.log(`[S3] Successfully uploaded screenshot ${fileName} to bucket ${process.env.S3_ASSETS_BUCKET}`);
      } catch (err: any) {
        console.error(`[S3] Failed to upload screenshot to S3: ${err.message}`);
        throw err;
      }
    } else {
      const filePath = path.join(privateUploadDir, fileName);
      fs.writeFileSync(filePath, fileBuffer);
    }

    // Update order status to Verification Pending and store filename
    await this.dataSource.query(`
      UPDATE orders 
      SET status = 'Verification Pending', screenshot_url = $1, updated_at = NOW()
      WHERE id = $2;
    `, [fileName, orderId]);

    // Send admin notification alert
    await this.createSystemNotification(
      'Payment Uploaded',
      `Order ${orderId.slice(0, 8)} uploaded a transaction receipt. Pending verification.`,
      'payment',
      orderId
    );

    await this.writeAuditLog(
      'UPLOAD_RECEIPT',
      'orders',
      orderId,
      'Customer',
      ipAddress,
      { status: 'Reserved' },
      { status: 'Verification Pending', file: fileName }
    );

    return { success: true };
  }

  async getPrivateScreenshotStream(orderId: string) {
    const rows = await this.dataSource.query(
      "SELECT screenshot_url, advance_screenshot_url FROM orders WHERE id = $1", 
      [orderId]
    );
    if (rows.length === 0) return null;
    
    const fileName = rows[0].screenshot_url || rows[0].advance_screenshot_url;
    if (!fileName) return null;

    if (process.env.S3_ASSETS_BUCKET) {
      try {
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const res = await s3.send(new GetObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET,
          Key: `uploads/${fileName}`
        }));
        return {
          stream: res.Body as any,
          filename: fileName
        };
      } catch (err: any) {
        console.error(`[S3] Failed to download screenshot from S3: ${err.message}`);
        return null;
      }
    } else {
      const filePath = path.join(privateUploadDir, fileName);
      if (!fs.existsSync(filePath)) return null;

      return {
        stream: fs.createReadStream(filePath),
        filename: fileName
      };
    }
  }

  async uploadImage(fileBuffer: Buffer, fileName: string, mimetype: string, folder: string) {
    if (process.env.S3_ASSETS_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET,
          Key: `uploads/${fileName}`,
          Body: fileBuffer,
          ContentType: mimetype
        }));
        console.log(`[S3] Uploaded public image: ${fileName}`);
        return `https://${process.env.S3_ASSETS_BUCKET}.s3.amazonaws.com/uploads/${fileName}`;
      } catch (err: any) {
        console.error(`[S3] uploadImage failed: ${err.message}`);
      }
    }
    const filePath = path.join(privateUploadDir, fileName);
    fs.writeFileSync(filePath, fileBuffer);
    return `/api/v1/images/${fileName}`;
  }

  async getPublicImageStream(filename: string) {
    if (process.env.S3_ASSETS_BUCKET) {
      try {
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const res = await s3.send(new GetObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET,
          Key: `uploads/${filename}`
        }));
        return {
          stream: res.Body as any,
          filename
        };
      } catch (err: any) {
        console.error(`[S3] getPublicImageStream failed: ${err.message}`);
      }
    }
    const filePath = path.join(privateUploadDir, filename);
    if (!fs.existsSync(filePath)) return null;
    return {
      stream: fs.createReadStream(filePath),
      filename
    };
  }

  // ── TIMER EXPIRATION WORKER METHOD ─────────────────────────────────
  async expireActiveReservations() {
    const expired = await this.dataSource.query(`
      SELECT r.id, r.product_id, r.order_id, r.quantity, o.user_id, u.email
      FROM reservations r
      JOIN orders o ON o.id = r.order_id
      JOIN users u ON u.id = o.user_id
      WHERE r.status = 'Active' AND r.expires_at < NOW();
    `);

    for (const r of expired) {
      console.log(`[Worker] Expiring stock lock reservation ID: ${r.id} for product: ${r.product_id}`);
      
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        // Set statuses to Expired
        await queryRunner.query("UPDATE reservations SET status = 'Expired' WHERE id = $1", [r.id]);
        await queryRunner.query("UPDATE orders SET status = 'Expired', updated_at = NOW() WHERE id = $1", [r.order_id]);

        // Release locked stock
        await queryRunner.query(`
          UPDATE products 
          SET locked_stock = GREATEST(0, locked_stock - $1), updated_at = NOW()
          WHERE id = $2;
        `, [r.quantity, r.product_id]);

        await queryRunner.commitTransaction();
        localCache.del('products_list_true');
        localCache.del('products_list_false');

        // Create alert notifications
        await this.createSystemNotification(
          'Reservation Expired',
          `Acquisition lock expired for user ${r.email}. Stock restored.`,
          'timer_alert'
        );

        await this.writeAuditLog(
          'RESERVATION_EXPIRED',
          'reservations',
          r.id,
          'System Worker',
          '127.0.0.1',
          { status: 'Active' },
          { status: 'Expired' }
        );

      } catch (err) {
        await queryRunner.rollbackTransaction();
        console.error(`[Worker] Expiration transaction rollback failed for reservation: ${r.id}:`, err);
      } finally {
        await queryRunner.release();
      }
    }
  }

  // ── ORDER PIPELINE STATE MANAGEMENT ───────────────────────────────
  async getAdminOrders() {
    return this.dataSource.query(`
      SELECT o.id, o.status, o.total_price as "totalPrice", o.shipping_address as "shippingAddress", o.tracking_number as "trackingNumber", o.created_at as "createdAt",
             o.screenshot_url as "screenshotUrl", o.courier_partner as "courierPartner", o.shipping_cost as "shippingCost",
             o.packaging_cost as "packagingCost", o.dispatch_date as "dispatchDate", o.delivery_date as "deliveryDate",
             COALESCE(o.booking_type, 'standard') as "bookingType",
             COALESCE(o.advance_amount, 0) as "advanceAmount",
             COALESCE(o.remaining_amount, 0) as "remainingAmount",
             o.advance_screenshot_url as "advanceScreenshotUrl",
             u.email as "customerEmail", c.instagram as "instagramUsername", c.full_name as "customerName",
             c.phone as "customerPhone", c.address as "customerAddress",
             p.model_name as "productName", p.brand as "productBrand", oi.price_at_purchase as "priceAtPurchase", oi.qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
      JOIN users u ON u.id = o.user_id
      LEFT JOIN customers c ON c.email = u.email
      ORDER BY o.created_at DESC;
    `);
  }

  async getPaginatedAdminOrders(options: { page?: number; limit?: number; search?: string; status?: string }) {
    const page = Math.max(1, Number(options.page || 1));
    const limit = Math.max(1, Math.min(100, Number(options.limit || 12)));
    const offset = (page - 1) * limit;

    let queryStr = `
      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN customers c ON c.email = u.email
      WHERE o.deleted_at IS NULL
    `;

    const params: any[] = [];
    let paramIndex = 1;

    const validStatuses = ['Pending', 'Paid', 'Shipped', 'Delivered', 'Cancelled', 'Confirmed', 'Reserved', 'Verification Pending'];
    if (options.status && options.status !== 'All') {
      const sanitizedStatus = validStatuses.includes(options.status) ? options.status : null;
      if (sanitizedStatus) {
        queryStr += ` AND o.status = $${paramIndex}`;
        params.push(sanitizedStatus);
        paramIndex++;
      }
    }

    if (options.search) {
      queryStr += ` AND (
        LOWER(c.full_name) LIKE LOWER($${paramIndex}) OR
        LOWER(c.phone) LIKE LOWER($${paramIndex}) OR
        LOWER(u.email) LIKE LOWER($${paramIndex}) OR
        CAST(o.id AS TEXT) LIKE $${paramIndex}
      )`;
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    const countQuery = `SELECT COUNT(DISTINCT o.id)::int as total ${queryStr}`;
    const countRes = await this.dataSource.query(countQuery, params);
    const total = countRes[0]?.total || 0;

    const idsQuery = `SELECT o.id ${queryStr} GROUP BY o.id, o.created_at ORDER BY o.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    const idsParams = [...params, limit, offset];
    const idsRes = await this.dataSource.query(idsQuery, idsParams);
    
    if (idsRes.length === 0) {
      return { orders: [], total, page, limit, totalPages: 0 };
    }

    const orderIds = idsRes.map(row => row.id);

    const ordersWithItems = await this.dataSource.query(`
      SELECT o.id, o.status, o.total_price as "totalPrice", o.shipping_address as "shippingAddress", o.tracking_number as "trackingNumber", o.created_at as "createdAt",
             o.screenshot_url as "screenshotUrl", o.courier_partner as "courierPartner", o.shipping_cost as "shippingCost",
             o.packaging_cost as "packagingCost", o.dispatch_date as "dispatchDate", o.delivery_date as "deliveryDate",
             COALESCE(o.booking_type, 'standard') as "bookingType",
             COALESCE(o.advance_amount, 0) as "advanceAmount",
             COALESCE(o.remaining_amount, 0) as "remainingAmount",
             o.advance_screenshot_url as "advanceScreenshotUrl",
             u.email as "customerEmail", c.instagram as "instagramUsername", c.full_name as "customerName",
             c.phone as "customerPhone", c.address as "customerAddress",
             p.model_name as "productName", p.brand as "productBrand", oi.price_at_purchase as "priceAtPurchase", oi.qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
      JOIN users u ON u.id = o.user_id
      LEFT JOIN customers c ON c.email = u.email
      WHERE o.id = ANY($1)
      ORDER BY o.created_at DESC;
    `, [orderIds]);

    const pendingRes = await this.dataSource.query(`
      SELECT COUNT(id)::int as count FROM orders WHERE status = 'Verification Pending' AND deleted_at IS NULL
    `);
    const pendingCount = pendingRes[0]?.count || 0;

    return {
      orders: ordersWithItems,
      total,
      pendingCount,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }


  async getCustomerOrders(email: string) {
    return this.dataSource.query(`
      SELECT o.id, o.status, o.total_price as "totalPrice", o.shipping_address as "shippingAddress",
             o.tracking_number as "trackingNumber", o.created_at as "createdAt",
             o.booking_type as "bookingType", o.advance_amount as "advanceAmount",
             o.remaining_amount as "remainingAmount", o.reservation_expires_at as "expiresAt",
             p.model_name as "productName", p.brand as "productBrand",
             oi.price_at_purchase as "priceAtPurchase", oi.qty,
             o.screenshot_url as "screenshotUrl"
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
      JOIN users u ON u.id = o.user_id
      WHERE u.email = $1 AND o.deleted_at IS NULL
      ORDER BY o.created_at DESC;
    `, [email.trim().toLowerCase()]);
  }
  async adminConfirmOrder(orderId: string, adminEmail: string, ipAddress: string) {
    const oldRes = await this.dataSource.query("SELECT status, booking_type FROM orders WHERE id = $1", [orderId]);
    if (oldRes.length === 0) {
      throw new Error("Order not found.");
    }
    if (oldRes[0].status === 'Confirmed' || oldRes[0].status === 'Pre-Order') {
      return { success: true };
    }
    
    const bookingType = oldRes[0].booking_type;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get order items
      const items = await queryRunner.query('SELECT id as "orderItemId", product_id, qty FROM order_items WHERE order_id = $1', [orderId]);
      for (const item of items) {
        // Lock aggregate caches
        const invRows = await queryRunner.query(`
          SELECT quantity_available, quantity_reserved
          FROM inventory
          WHERE product_id = $1
          FOR UPDATE;
        `, [item.product_id]);
        
        const prodRows = await queryRunner.query(`
          SELECT id, model_name as name, total_stock, locked_stock, sold_stock
          FROM products 
          WHERE id = $1 AND deleted_at IS NULL 
          FOR UPDATE;
        `, [item.product_id]);

        if (prodRows.length === 0) {
          throw new Error("Target casting does not exist or has been archived.");
        }
        
        // Select available batches in FIFO order
        const batches = await queryRunner.query(`
          SELECT id, purchase_price, selling_price, quantity_available, quantity_reserved
          FROM inventory_batches
          WHERE product_id = $1 AND quantity_available > 0
          ORDER BY received_at ASC
          FOR UPDATE;
        `, [item.product_id]);
        
        const totalAvailable = batches.reduce((sum, b) => sum + Number(b.quantity_available), 0);
        
        // If it's a standard order, we must have enough stock
        if (bookingType !== 'pre_order' && totalAvailable < Number(item.qty)) {
          throw new Error(`Cannot approve order. Casting "${prodRows[0].name}" is sold out. Available: ${totalAvailable}, requested: ${item.qty}.`);
        }
        
        // Deplete stock from batches using FIFO (only if stock is available)
        let remainingToAllocate = Number(item.qty);
        let mixedCostSum = 0;
        let allocatedCount = 0;
        
        for (const b of batches) {
          if (remainingToAllocate <= 0) break;
          const allocQty = Math.min(remainingToAllocate, Number(b.quantity_available));
          
          // Allocate: available -> reserved
          await queryRunner.query(`
            UPDATE inventory_batches
            SET quantity_available = quantity_available - $1,
                quantity_reserved = quantity_reserved + $1,
                status = CASE WHEN quantity_available - $1 = 0 THEN 'Fully Consumed'::VARCHAR ELSE 'Partially Used'::VARCHAR END,
                updated_at = NOW()
            WHERE id = $2;
          `, [allocQty, b.id]);
          
          // Record allocation
          await queryRunner.query(`
            INSERT INTO order_inventory_allocations (order_item_id, batch_id, quantity, purchase_price, selling_price)
            VALUES ($1, $2, $3, $4, $5);
          `, [item.orderItemId, b.id, allocQty, Number(b.purchase_price), Number(b.selling_price)]);
          
          // Record ledger RESERVE
          await queryRunner.query(`
            INSERT INTO inventory_ledger (product_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
            VALUES ($1, $2, $3, 'RESERVE', $4, $5, $6, $7, $8);
          `, [item.product_id, b.id, orderId, -allocQty, Number(b.purchase_price), Number(b.selling_price), `Reserved stock for order approval`, adminEmail || 'System']);
          
          mixedCostSum += Number(b.purchase_price) * allocQty;
          remainingToAllocate -= allocQty;
          allocatedCount += allocQty;
        }
        
        if (allocatedCount > 0) {
          const avgUnitCost = mixedCostSum / allocatedCount;
          // Save the cost permanently on the order item
          await queryRunner.query(`
            UPDATE order_items
            SET purchase_price_at_purchase = $1
            WHERE id = $2;
          `, [avgUnitCost, item.orderItemId]);
          
          // Update products total stock cache
          await queryRunner.query(`
            UPDATE products
            SET locked_stock = locked_stock + $1, -- reserving stock (locked_stock acts as reserved)
                updated_at = NOW()
            WHERE id = $2;
          `, [allocatedCount, item.product_id]);
          
          // Update inventory cache
          await queryRunner.query(`
            UPDATE inventory
            SET quantity_available = quantity_available - $1,
                quantity_reserved = quantity_reserved + $1,
                updated_at = NOW()
            WHERE product_id = $2;
          `, [allocatedCount, item.product_id]);
        }
      }

      // Get booking details to determine correct final status and billing updates
      const orderDetails = await queryRunner.query("SELECT booking_type, remaining_amount, advance_amount, total_price FROM orders WHERE id = $1", [orderId]);
      const order = orderDetails[0];
      const isInitialPreorder = order && order.booking_type === 'pre_order' && Number(order.remaining_amount) > 0;
      const targetStatus = isInitialPreorder ? 'Pre-Order' : 'Confirmed';

      await queryRunner.query("UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2", [targetStatus, orderId]);
      await queryRunner.query("UPDATE reservations SET status = 'Converted' WHERE order_id = $1", [orderId]);

      if (isInitialPreorder) {
        await queryRunner.query(`
          UPDATE receipts 
          SET pending_balance = $1, advance_paid = $2
          WHERE receipt_number = $3
        `, [Number(order.remaining_amount), Number(order.advance_amount), orderId]);
      } else {
        // Update billing receipt if exists to reflect fully paid
        await queryRunner.query(`
          UPDATE receipts 
          SET pending_balance = 0.00, advance_paid = total_amount
          WHERE receipt_number = $1
        `, [orderId]);
      }

      // Record payment in cash ledger
      const accounts = await queryRunner.query("SELECT id FROM cash_accounts WHERE name ILIKE '%UPI%' AND is_active = true LIMIT 1;");
      const cashAccountId = accounts[0]?.id || (await queryRunner.query("SELECT id FROM cash_accounts WHERE is_active = true LIMIT 1;"))[0]?.id;
      
      const ledgerAmount = isInitialPreorder ? Number(order.advance_amount) : Number(order.total_price);
      const ledgerType = isInitialPreorder ? 'Pre-order Advance' : 'Customer Payment';
      
      if (cashAccountId) {
        await queryRunner.query(`
          INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
          VALUES ($1, $2, $3, 'Completed', 'Order', $4, $5, $6, NOW(), $7);
        `, [
          cashAccountId,
          ledgerAmount,
          ledgerType,
          orderId,
          `Payment verified for order ${orderId}`,
          `Auto-created on order confirmation`,
          adminEmail || 'System'
        ]);
      }

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      await this.writeAuditLog(
        'ORDER_APPROVED',
        'orders',
        orderId,
        adminEmail,
        ipAddress,
        oldRes[0],
        { status: targetStatus }
      );

      return { success: true };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
  async adminUpdateOrderStatus(orderId: string, fields: any, adminEmail: string, ipAddress: string) {
    const oldRes = await this.dataSource.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    const old = oldRes[0];

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(`
        UPDATE orders
        SET status = $1, courier_partner = $2, tracking_number = $3,
            shipping_cost = $4, packaging_cost = $5, dispatch_date = $6, delivery_date = $7,
            updated_at = NOW()
        WHERE id = $8;
      `, [
        fields.status || old.status,
        fields.courierPartner || old.courier_partner,
        fields.trackingNumber || old.tracking_number,
        fields.shippingCost !== undefined ? Number(fields.shippingCost) : old.shipping_cost,
        fields.packagingCost !== undefined ? Number(fields.packagingCost) : old.packaging_cost,
        fields.dispatchDate || old.dispatch_date,
        fields.deliveryDate || old.delivery_date,
        orderId
      ]);

      // If status transitioned to Paid, Confirmed, Shipped, or Delivered, mark receipt as paid
      const targetStatus = fields.status || old.status;
      if (targetStatus === 'Paid' || targetStatus === 'Confirmed' || targetStatus === 'Shipped' || targetStatus === 'Delivered') {
        await queryRunner.query(`
          UPDATE receipts 
          SET pending_balance = 0.00, advance_paid = total_amount
          WHERE receipt_number = $1
        `, [orderId]);

        if (old.status === 'Verification Pending' && old.booking_type === 'pre_order') {
          const accounts = await queryRunner.query("SELECT id FROM cash_accounts WHERE name ILIKE '%UPI%' AND is_active = true LIMIT 1;");
          const cashAccountId = accounts[0]?.id || (await queryRunner.query("SELECT id FROM cash_accounts WHERE is_active = true LIMIT 1;"))[0]?.id;
          
          const remainingAmount = Number(old.remaining_amount);
          if (remainingAmount > 0 && cashAccountId) {
            await queryRunner.query(`
              INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
              VALUES ($1, $2, 'Pre-order Remaining Payment', 'Completed', 'Order', $3, $4, $5, NOW(), $6);
            `, [
              cashAccountId,
              remainingAmount,
              orderId,
              `Remaining payment verified for pre-order ${orderId}`,
              `Auto-created on remaining payment verification`,
              adminEmail || 'System'
            ]);
          }
        }
      }

      // Transition stock from Reserved to Sold on Shipment/Delivery
      if ((targetStatus === 'Shipped' || targetStatus === 'Delivered') && old.status === 'Confirmed') {
        const allocations = await queryRunner.query(`
          SELECT a.*, oi.product_id 
          FROM order_inventory_allocations a
          JOIN order_items oi ON oi.id = a.order_item_id
          WHERE oi.order_id = $1;
        `, [orderId]);

        for (const a of allocations) {
          // Decrement reserved, increment sold
          await queryRunner.query(`
            UPDATE inventory_batches
            SET quantity_reserved = GREATEST(0, quantity_reserved - $1),
                quantity_sold = quantity_sold + $1,
                updated_at = NOW()
            WHERE id = $2;
          `, [a.quantity, a.batch_id]);

          // Log to ledger
          await queryRunner.query(`
            INSERT INTO inventory_ledger (product_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
            VALUES ($1, $2, $3, 'SELL', 0, $4, $5, $6, $7);
          `, [a.product_id, a.batch_id, orderId, Number(a.purchase_price), Number(a.selling_price), `Shipped/Delivered stock finalized`, adminEmail || 'System']);

          // Update caches
          await queryRunner.query(`
            UPDATE products
            SET locked_stock = GREATEST(0, locked_stock - $1),
                sold_stock = sold_stock + $1,
                updated_at = NOW()
            WHERE id = $2;
          `, [a.quantity, a.product_id]);

          await queryRunner.query(`
            UPDATE inventory
            SET quantity_reserved = GREATEST(0, quantity_reserved - $1),
                quantity_sold = quantity_sold + $1,
                updated_at = NOW()
            WHERE product_id = $2;
          `, [a.quantity, a.product_id]);
        }
      }

      // If status transitioned to Cancelled, release stock and allocations
      if (targetStatus === 'Cancelled' && old.status !== 'Cancelled') {
        const allocations = await queryRunner.query(`
          SELECT a.*, oi.product_id 
          FROM order_inventory_allocations a
          JOIN order_items oi ON oi.id = a.order_item_id
          WHERE oi.order_id = $1;
        `, [orderId]);

        for (const a of allocations) {
          if (old.status === 'Confirmed' || old.status === 'Pre-Order') {
            // Stock was Reserved. Return to Available.
            await queryRunner.query(`
              UPDATE inventory_batches
              SET quantity_reserved = GREATEST(0, quantity_reserved - $1),
                  quantity_available = quantity_available + $1,
                  status = 'Partially Used'::VARCHAR,
                  updated_at = NOW()
              WHERE id = $2;
            `, [a.quantity, a.batch_id]);

            await queryRunner.query(`
              INSERT INTO inventory_ledger (product_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
              VALUES ($1, $2, $3, 'RELEASE_RESERVATION', $4, $5, $6, $7, $8);
            `, [a.product_id, a.batch_id, orderId, a.quantity, Number(a.purchase_price), Number(a.selling_price), `Released reservation from cancelled order`, adminEmail || 'System']);

            await queryRunner.query(`
              UPDATE products
              SET locked_stock = GREATEST(0, locked_stock - $1),
                  updated_at = NOW()
              WHERE id = $2;
            `, [a.quantity, a.product_id]);

            await queryRunner.query(`
              UPDATE inventory
              SET quantity_reserved = GREATEST(0, quantity_reserved - $1),
                  quantity_available = quantity_available + $1,
                  updated_at = NOW()
              WHERE product_id = $2;
            `, [a.quantity, a.product_id]);

          } else if (old.status === 'Shipped' || old.status === 'Delivered') {
            // Stock was Sold. Return to Returned/Stock.
            await queryRunner.query(`
              UPDATE inventory_batches
              SET quantity_sold = GREATEST(0, quantity_sold - $1),
                  quantity_returned = quantity_returned + $1,
                  updated_at = NOW()
              WHERE id = $2;
            `, [a.quantity, a.batch_id]);

            await queryRunner.query(`
              INSERT INTO inventory_ledger (product_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
              VALUES ($1, $2, $3, 'RETURN_CUSTOMER', $4, $5, $6, $7, $8);
            `, [a.product_id, a.batch_id, orderId, a.quantity, Number(a.purchase_price), Number(a.selling_price), `Returned stock from cancelled order`, adminEmail || 'System']);

            await queryRunner.query(`
              UPDATE products
              SET sold_stock = GREATEST(0, sold_stock - $1),
                  updated_at = NOW()
              WHERE id = $2;
            `, [a.quantity, a.product_id]);

            await queryRunner.query(`
              UPDATE inventory
              SET quantity_sold = GREATEST(0, quantity_sold - $1),
                  quantity_returned = quantity_returned + $1,
                  updated_at = NOW()
              WHERE product_id = $2;
            `, [a.quantity, a.product_id]);
          }
        }

        // Delete allocations since order is cancelled
        await queryRunner.query(`
          DELETE FROM order_inventory_allocations 
          WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1);
        `, [orderId]);

        if (old.status === 'Confirmed' || old.status === 'Pre-Order' || old.status === 'Shipped' || old.status === 'Delivered') {
          const refundAmount = old.status === 'Pre-Order' ? Number(old.advance_amount) : Number(old.total_price);
          if (refundAmount > 0) {
            const refundRes = await queryRunner.query(`
              INSERT INTO refunds (order_id, amount, status, reason, restock_inventory)
              VALUES ($1, $2, 'Completed', $3, true)
              RETURNING id;
            `, [orderId, refundAmount, `Refund for cancelled order ${orderId}`]);

            const accounts = await queryRunner.query("SELECT id FROM cash_accounts WHERE name ILIKE '%UPI%' AND is_active = true LIMIT 1;");
            const cashAccountId = accounts[0]?.id || (await queryRunner.query("SELECT id FROM cash_accounts WHERE is_active = true LIMIT 1;"))[0]?.id;

            if (cashAccountId) {
              await queryRunner.query(`
                INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
                VALUES ($1, $2, 'Refund', 'Completed', 'Refund', $3, $4, $5, NOW(), $6);
              `, [
                cashAccountId,
                -refundAmount,
                refundRes[0].id,
                `Customer refund processed for order ${orderId}`,
                `Auto-created on order cancellation`,
                adminEmail || 'System'
              ]);
            }
          }
        }
      }

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      await this.writeAuditLog(
        'UPDATE_ORDER_STATUS',
        'orders',
        orderId,
        adminEmail,
        ipAddress,
        old,
        fields
      );

      return { success: true };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  // ── PRE-ORDER: COLLECT REMAINING PAYMENT ──────────────────────────
  async collectRemainingPayment(orderId: string, fileBuffer: Buffer, fileExtension: string, adminEmail: string, ipAddress: string) {
    const orderRows = await this.dataSource.query(
      "SELECT id, status, booking_type, remaining_amount FROM orders WHERE id = $1",
      [orderId]
    );
    if (orderRows.length === 0) throw new BadRequestException('Order not found.');
    const order = orderRows[0];
    if (order.booking_type !== 'pre_order') throw new BadRequestException('This order is not a pre-order.');

    const fileName = `remain_${crypto.randomUUID()}.${fileExtension}`;
    
    if (process.env.S3_ASSETS_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET,
          Key: `uploads/${fileName}`,
          Body: fileBuffer,
          ContentType: `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`
        }));
        console.log(`[S3] Successfully uploaded remaining screenshot ${fileName} to bucket ${process.env.S3_ASSETS_BUCKET}`);
      } catch (err: any) {
        console.error(`[S3] Failed to upload remaining screenshot to S3: ${err.message}`);
        throw err;
      }
    } else {
      const filePath = path.join(privateUploadDir, fileName);
      fs.writeFileSync(filePath, fileBuffer);
    }

    await this.dataSource.query(`
      UPDATE orders
      SET advance_screenshot_url = $1,
          remaining_amount = 0,
          advance_amount = total_price,
          status = 'Verification Pending',
          updated_at = NOW()
      WHERE id = $2;
    `, [fileName, orderId]);

    await this.createSystemNotification(
      'Pre-Order: Remaining Payment Received',
      `Order ${orderId.slice(0, 8)} has submitted the remaining payment. Please verify and confirm.`,
      'payment',
      orderId
    );

    await this.writeAuditLog(
      'PREORDER_REMAINING_COLLECTED',
      'orders',
      orderId,
      adminEmail,
      ipAddress,
      order,
      { status: 'Verification Pending', remaining_amount: 0 }
    );

    return { success: true };
  }

  async customerSubmitRemainingPayment(orderId: string, fileBuffer: Buffer, fileExtension: string, userId: string, ipAddress: string) {
    const orderRows = await this.dataSource.query(
      "SELECT id, status, booking_type, remaining_amount, user_id FROM orders WHERE id = $1 AND deleted_at IS NULL",
      [orderId]
    );
    if (orderRows.length === 0) throw new BadRequestException('Order not found.');
    const order = orderRows[0];
    if (order.user_id !== userId) {
      throw new UnauthorizedException('You do not have permission to update this order.');
    }
    if (order.booking_type !== 'pre_order') throw new BadRequestException('This order is not a pre-order.');
    if (order.status !== 'Awaiting Stock') {
      throw new BadRequestException('Remaining payment has not been requested for this order yet.');
    }

    const fileName = `remain_${crypto.randomUUID()}.${fileExtension}`;
    
    if (process.env.S3_ASSETS_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET,
          Key: `uploads/${fileName}`,
          Body: fileBuffer,
          ContentType: `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`
        }));
        console.log(`[S3] Customer uploaded remaining screenshot ${fileName} to bucket ${process.env.S3_ASSETS_BUCKET}`);
      } catch (err: any) {
        console.error(`[S3] Failed to upload remaining screenshot to S3: ${err.message}`);
        throw err;
      }
    } else {
      const filePath = path.join(privateUploadDir, fileName);
      fs.writeFileSync(filePath, fileBuffer);
    }

    await this.dataSource.query(`
      UPDATE orders
      SET advance_screenshot_url = $1,
          status = 'Verification Pending',
          updated_at = NOW()
      WHERE id = $2;
    `, [fileName, orderId]);

    await this.createSystemNotification(
      'Pre-Order: Remaining Payment Uploaded',
      `Customer has uploaded remaining payment receipt for Order ${orderId.slice(0, 8)}. Verification required.`,
      'payment',
      orderId
    );

    await this.writeAuditLog(
      'PREORDER_REMAINING_SUBMITTED',
      'orders',
      orderId,
      'Customer',
      ipAddress,
      order,
      { status: 'Verification Pending', advance_screenshot_url: fileName }
    );

    return { success: true };
  }

  // ── FORMAL RECEIPT DATA GENERATOR ─────────────────────────────────
  async generateReceiptForOrder(orderId: string) {
    const orderRows = await this.dataSource.query(`
      SELECT o.id, o.status, o.total_price as "totalPrice", o.shipping_address as "shippingAddress",
             o.shipping_cost as "shippingCost", o.packaging_cost as "packagingCost",
             o.created_at as "createdAt", o.booking_type as "bookingType",
             o.advance_amount as "advanceAmount", o.remaining_amount as "remainingAmount",
             o.tracking_number as "trackingNumber", o.courier_partner as "courierPartner",
             u.email as "customerEmail",
             c.full_name as "customerName", c.phone as "customerPhone",
             c.instagram as "customerInstagram", c.address as "customerAddress"
      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN customers c ON c.email = u.email
      WHERE o.id = $1;
    `, [orderId]);

    if (orderRows.length === 0) throw new BadRequestException('Order not found.');
    const order = orderRows[0];

    const items = await this.dataSource.query(`
      SELECT p.model_name as name, p.brand, p.series, p.scale,
             oi.qty, oi.price_at_purchase as "unitPrice"
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1;
    `, [orderId]);

    const receiptNumber = `GK-${new Date().getFullYear()}-${orderId.slice(0, 8).toUpperCase()}`;
    const subtotal = items.reduce((sum: number, i: any) => sum + Number(i.unitPrice) * Number(i.qty), 0);
    const shippingCharges = Number(order.shippingCost || 0) + Number(order.packagingCost || 0);
    const totalAmount = Number(order.totalPrice);
    const advancePaid = Number(order.advanceAmount || totalAmount);
    const pendingBalance = Number(order.remainingAmount || 0);

    return {
      receiptNumber,
      orderId: order.id,
      date: order.createdAt,
      status: order.status,
      bookingType: order.bookingType || 'standard',
      customer: {
        name: order.customerName || 'Guest Customer',
        email: order.customerEmail || '',
        phone: order.customerPhone || '',
        instagram: order.customerInstagram || '',
        address: order.customerAddress || order.shippingAddress || ''
      },
      items: items.map((i: any) => ({
        name: `${i.brand} ${i.name}`,
        series: i.series || '',
        scale: i.scale || '1:64',
        qty: Number(i.qty),
        unitPrice: Number(i.unitPrice),
        lineTotal: Number(i.unitPrice) * Number(i.qty)
      })),
      subtotal,
      shippingCharges,
      totalAmount,
      advancePaid,
      pendingBalance,
      trackingNumber: order.trackingNumber || null,
      courierPartner: order.courierPartner || null
    };
  }

  // ── CUSTOMERS CRM MODULE ───────────────────────────────────────────
  async getCustomers() {
    return this.dataSource.query(`
      SELECT c.id, c.full_name as name, c.instagram as "instagramUsername", c.phone, c.email, c.city, c.notes, c.created_at as "createdAt",
             COALESCE(COUNT(o.id) FILTER (WHERE o.status = 'Confirmed' OR o.status = 'Shipped' OR o.status = 'Delivered'), 0) as "totalOrders",
             COALESCE(SUM(o.total_price) FILTER (WHERE o.status = 'Confirmed' OR o.status = 'Shipped' OR o.status = 'Delivered'), 0) as "totalSpend",
             MAX(o.created_at) FILTER (WHERE o.status = 'Confirmed' OR o.status = 'Shipped' OR o.status = 'Delivered') as "lastOrderDate"
      FROM customers c
      LEFT JOIN users u ON u.email = c.email
      LEFT JOIN orders o ON o.user_id = u.id
      GROUP BY c.id
      ORDER BY "totalSpend" DESC;
    `);
  }

  // ── EXPENSE LOGS MODULE ────────────────────────────────────────────
  async getExpenses() {
    return this.dataSource.query(`
      SELECT id, title, amount, category, paid_by as "paidBy", date, notes, created_at
      FROM expenses
      WHERE deleted_at IS NULL
      ORDER BY date DESC;
    `);
  }

  async getPaginatedExpenses(options: { page?: number; limit?: number; search?: string }) {
    const page = Math.max(1, Number(options.page || 1));
    const limit = Math.max(1, Math.min(100, Number(options.limit || 12)));
    const offset = (page - 1) * limit;

    let queryStr = `
      FROM expenses
      WHERE deleted_at IS NULL
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (options.search) {
      queryStr += ` AND (
        LOWER(title) LIKE LOWER($${paramIndex}) OR
        LOWER(category) LIKE LOWER($${paramIndex}) OR
        LOWER(notes) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    const countQuery = `SELECT COUNT(id)::int as total ${queryStr}`;
    const countRes = await this.dataSource.query(countQuery, params);
    const total = countRes[0]?.total || 0;

    const selectQuery = `
      SELECT id, title, amount, category, paid_by as "paidBy", date, notes, created_at
      ${queryStr}
      ORDER BY date DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    const rows = await this.dataSource.query(selectQuery, [...params, limit, offset]);

    return {
      expenses: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }


  async addExpense(exp: any, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.query(`
        INSERT INTO expenses (title, amount, category, paid_by, date, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id;
      `, [exp.title, Number(exp.amount), exp.category, exp.paidBy, exp.date, exp.notes || '']);
      const expenseId = result[0].id;

      const accounts = await queryRunner.query("SELECT id FROM cash_accounts WHERE name ILIKE '%Petty%' OR name ILIKE '%Drawer%' AND is_active = true LIMIT 1;");
      const cashAccountId = accounts[0]?.id || (await queryRunner.query("SELECT id FROM cash_accounts WHERE is_active = true LIMIT 1;"))[0]?.id;

      if (cashAccountId) {
        await queryRunner.query(`
          INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
          VALUES ($1, $2, 'Operating Expense', 'Completed', 'Expense', $3, $4, $5, $6, $7);
        `, [
          cashAccountId,
          -Number(exp.amount),
          expenseId,
          exp.title,
          `Expense logged: ${exp.title}`,
          exp.date ? new Date(exp.date) : new Date(),
          adminEmail
        ]);

        const founders = ['Harshal', 'Anutosh', 'Sanchit', 'Anish'];
        if (founders.includes(exp.paidBy)) {
          await queryRunner.query(`
            INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, founder_name, date, created_by)
            VALUES ($1, $2, 'Founder Contribution', 'Completed', 'Founder Ledger', 'Contribution', $3, $4, $5, $6, $7);
          `, [
            cashAccountId,
            Number(exp.amount),
            expenseId,
            `Founder Contribution for expense: ${exp.title}`,
            `Auto-created on expense log (paid personally)`,
            exp.paidBy,
            exp.date ? new Date(exp.date) : new Date(),
            adminEmail
          ]);
        }
      }

      await this.writeAuditLog(
        'CREATE_EXPENSE',
        'expenses',
        expenseId,
        adminEmail,
        ipAddress,
        null,
        exp
      );

      await queryRunner.commitTransaction();
      return result[0];
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  async softDeleteExpense(id: string, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const old = await queryRunner.query("SELECT * FROM expenses WHERE id = $1", [id]);
      if (old.length === 0) throw new BadRequestException('Expense not found.');
      
      await queryRunner.query("UPDATE expenses SET deleted_at = NOW() WHERE id = $1", [id]);

      const ledgerEntries = await queryRunner.query(`
        SELECT * FROM cash_ledger 
        WHERE source_type = 'Expense' AND source_id = $1 AND status = 'Completed';
      `, [id]);

      for (const entry of ledgerEntries) {
        await queryRunner.query(`
          INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
          VALUES ($1, $2, 'Cash Adjustment', 'Completed', 'Expense', $3, $4, $5, NOW(), $6);
        `, [
          entry.cash_account_id,
          -Number(entry.amount),
          id,
          `Reversed entry: ${entry.reason}`,
          `Reconciliation adjustment for soft-deleted expense ${id}`,
          adminEmail
        ]);
      }

      await this.writeAuditLog(
        'DELETE_EXPENSE',
        'expenses',
        id,
        adminEmail,
        ipAddress,
        old[0],
        { deleted: true }
      );

      await queryRunner.commitTransaction();
      return { success: true };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ── FOUNDER SPLITS & FINANCE METRICS ────────────────────────────────
  getDateFilter(timeRange: string): { start: Date; end: Date } {
    const end = new Date();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    switch (timeRange) {
      case 'Today':
        break;
      case 'Yesterday':
        start.setDate(start.getDate() - 1);
        end.setDate(end.getDate() - 1);
        break;
      case 'Last 7 Days':
        start.setDate(start.getDate() - 6);
        break;
      case 'Last 30 Days':
        start.setDate(start.getDate() - 29);
        break;
      case 'This Month':
        start.setDate(1);
        break;
      case 'Previous Month':
        start.setMonth(start.getMonth() - 1);
        start.setDate(1);
        end.setMonth(end.getMonth() - 1);
        end.setDate(new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate());
        break;
      case 'Quarter':
        const qStartMonth = Math.floor(start.getMonth() / 3) * 3;
        start.setMonth(qStartMonth);
        start.setDate(1);
        break;
      case 'Year To Date':
        start.setMonth(0);
        start.setDate(1);
        break;
      case 'Previous Year':
        start.setFullYear(start.getFullYear() - 1);
        start.setMonth(0);
        start.setDate(1);
        end.setFullYear(end.getFullYear() - 1);
        end.setMonth(11);
        end.setDate(31);
        break;
      case 'Lifetime':
      default:
        start.setFullYear(2020);
        break;
    }
    return { start, end };
  }

  getPreviousPeriod(timeRange: string): { start: Date; end: Date } {
    const current = this.getDateFilter(timeRange);
    const diff = current.end.getTime() - current.start.getTime();
    const start = new Date(current.start.getTime() - diff - 1);
    const end = new Date(current.start.getTime() - 1);
    return { start, end };
  }

  async getCashAccounts() {
    return this.dataSource.query("SELECT * FROM cash_accounts WHERE deleted_at IS NULL ORDER BY display_order ASC;");
  }

  async createCashAccount(name: string, type: string, openingBalance: number, currency: string, description: string) {
    const res = await this.dataSource.query(`
      INSERT INTO cash_accounts (name, type, opening_balance, currency, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id;
    `, [name, type, openingBalance, currency || 'INR', description || '']);
    return { success: true, id: res[0].id };
  }

  async getCashLedger(filters: { timeRange?: string; cashAccountId?: string; type?: string; limit?: number; offset?: number }) {
    const timeRange = filters.timeRange || 'Lifetime';
    const { start, end } = this.getDateFilter(timeRange);
    
    let queryStr = "SELECT l.*, a.name as cash_account_name FROM cash_ledger l LEFT JOIN cash_accounts a ON a.id = l.cash_account_id WHERE l.date BETWEEN $1 AND $2";
    const params: any[] = [start, end];
    let paramIndex = 3;

    if (filters.cashAccountId) {
      queryStr += ` AND l.cash_account_id = $${paramIndex}`;
      params.push(filters.cashAccountId);
      paramIndex++;
    }

    if (filters.type) {
      queryStr += ` AND l.type = $${paramIndex}`;
      params.push(filters.type);
      paramIndex++;
    }

    queryStr += " ORDER BY l.date DESC, l.created_at DESC";

    if (filters.limit) {
      queryStr += ` LIMIT $${paramIndex}`;
      params.push(Number(filters.limit));
      paramIndex++;
    }
    if (filters.offset) {
      queryStr += ` OFFSET $${paramIndex}`;
      params.push(Number(filters.offset));
      paramIndex++;
    }

    return this.dataSource.query(queryStr, params);
  }

  async addLedgerAdjustment(dto: { cashAccountId: string; amount: number; type: string; reason: string; notes?: string; referenceNumber?: string; date?: string }, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const dateVal = dto.date ? new Date(dto.date) : new Date();
      const res = await queryRunner.query(`
        INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reference_number, reason, notes, date, created_by)
        VALUES ($1, $2, $3, 'Completed', 'Manual Adjustment', 'Manual', $4, $5, $6, $7, $8)
        RETURNING id;
      `, [dto.cashAccountId, Number(dto.amount), dto.type, dto.referenceNumber || null, dto.reason, dto.notes || '', dateVal, adminEmail]);
      
      await this.writeAuditLog(
        'CREATE_LEDGER_ADJUSTMENT',
        'cash_ledger',
        res[0].id,
        adminEmail,
        ipAddress,
        null,
        { cashAccountId: dto.cashAccountId, amount: dto.amount, type: dto.type }
      );
      
      await queryRunner.commitTransaction();
      return { success: true, id: res[0].id };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  async getFinanceMetrics(timeRange = 'Lifetime', cashAccountId?: string) {
    const { start, end } = this.getDateFilter(timeRange);
    const prev = this.getPreviousPeriod(timeRange);

    const getMetricsForPeriod = async (s: Date, e: Date) => {
      let filterAcc = "";
      const params: any[] = [s, e];
      if (cashAccountId) {
        filterAcc = " AND cash_account_id = $3";
        params.push(cashAccountId);
      }

      const revRes = await this.dataSource.query(`
        SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger
        WHERE type IN ('Customer Payment', 'Pre-order Advance', 'Pre-order Remaining Payment')
          AND status = 'Completed'
          AND date BETWEEN $1 AND $2 ${filterAcc}
      `, params);
      const revenue = revRes[0].total;

      const cogsRes = await this.dataSource.query(`
        SELECT COALESCE(SUM(a.quantity * a.purchase_price), 0)::float as total
        FROM order_inventory_allocations a
        JOIN order_items oi ON oi.id = a.order_item_id
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
          AND o.created_at BETWEEN $1 AND $2
      `, [s, e]);
      const cogs = cogsRes[0].total;

      const expRes = await this.dataSource.query(`
        SELECT COALESCE(SUM(ABS(amount)), 0)::float as total FROM cash_ledger
        WHERE type = 'Operating Expense'
          AND status = 'Completed'
          AND date BETWEEN $1 AND $2 ${filterAcc}
      `, params);
      const expenses = expRes[0].total;

      const refRes = await this.dataSource.query(`
        SELECT COALESCE(SUM(amount), 0)::float as total FROM refunds
        WHERE status = 'Completed' AND created_at BETWEEN $1 AND $2
      `, [s, e]);
      const refunds = refRes[0].total;

      const refPendingRes = await this.dataSource.query(`
        SELECT COALESCE(SUM(amount), 0)::float as total FROM refunds
        WHERE status = 'Pending'
      `);
      const pendingRefunds = refPendingRes[0].total;

      const aovRes = await this.dataSource.query(`
        SELECT COALESCE(AVG(total_price), 0)::float as val FROM orders
        WHERE status IN ('Confirmed', 'Shipped', 'Delivered')
          AND created_at BETWEEN $1 AND $2
      `, [s, e]);
      const aov = aovRes[0].val;

      const grossProfit = revenue - cogs;
      const netProfit = grossProfit - expenses;

      return {
        revenue,
        cogs,
        grossProfit,
        expenses,
        netProfit,
        refunds,
        pendingRefunds,
        aov,
        grossMarginPct: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
        netMarginPct: revenue > 0 ? (netProfit / revenue) * 100 : 0,
        refundRate: revenue > 0 ? (refunds / revenue) * 100 : 0
      };
    };

    const currentMetrics = await getMetricsForPeriod(start, end);
    const prevMetrics = await getMetricsForPeriod(prev.start, prev.end);

    // Business Cash positions
    const cashBalRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger WHERE status = 'Completed'
    `);
    const currentCashBalance = cashBalRes[0].total;

    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    const cashInToday = (await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger
      WHERE amount > 0 AND status = 'Completed' AND date BETWEEN $1 AND $2
    `, [todayStart, todayEnd]))[0].total;

    const cashOutToday = (await this.dataSource.query(`
      SELECT COALESCE(SUM(ABS(amount)), 0)::float as total FROM cash_ledger
      WHERE amount < 0 AND status = 'Completed' AND date BETWEEN $1 AND $2
    `, [todayStart, todayEnd]))[0].total;

    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const cashInMonth = (await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger
      WHERE amount > 0 AND status = 'Completed' AND date BETWEEN $1 AND $2
    `, [monthStart, todayEnd]))[0].total;

    const cashOutMonth = (await this.dataSource.query(`
      SELECT COALESCE(SUM(ABS(amount)), 0)::float as total FROM cash_ledger
      WHERE amount < 0 AND status = 'Completed' AND date BETWEEN $1 AND $2
    `, [monthStart, todayEnd]))[0].total;

    const invValueRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(quantity_available * purchase_price), 0)::float as total FROM inventory_batches
    `);
    const inventoryAssetValue = invValueRes[0].total;

    // Outstanding founder capital
    const fContr = await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger
      WHERE type IN ('Founder Contribution', 'Founder Personal Inventory Purchase') AND status = 'Completed'
    `);
    const fReimb = await this.dataSource.query(`
      SELECT COALESCE(SUM(ABS(amount)), 0)::float as total FROM cash_ledger
      WHERE type = 'Founder Reimbursement' AND status = 'Completed'
    `);
    const outstandingFounderCapital = fContr[0].total - fReimb[0].total;

    const pendingPayRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(total_price), 0)::float as total FROM orders
      WHERE status = 'Verification Pending'
    `);
    const pendingPayments = pendingPayRes[0].total;

    return {
      ...currentMetrics,
      profit: currentMetrics.netProfit,
      pendingPayments,
      inventoryValue: inventoryAssetValue,
      currentCashBalance,
      cashInToday,
      cashOutToday,
      cashInThisMonth: cashInMonth,
      cashOutThisMonth: cashOutMonth,
      inventoryAssetValue,
      outstandingFounderCapital,
      trends: {
        revenueGrowth: prevMetrics.revenue > 0 ? ((currentMetrics.revenue - prevMetrics.revenue) / prevMetrics.revenue) * 100 : 0,
        netProfitGrowth: prevMetrics.netProfit > 0 ? ((currentMetrics.netProfit - prevMetrics.netProfit) / prevMetrics.netProfit) * 100 : 0
      }
    };
  }

  async getAnalyticsMetrics(timeRange = 'Lifetime') {
    const { start, end } = this.getDateFilter(timeRange);

    const topSeller = await this.dataSource.query(`
      SELECT p.model_name as name, p.brand, SUM(oi.qty) as sales
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
        AND o.created_at BETWEEN $1 AND $2
      GROUP BY p.id, p.model_name, p.brand
      ORDER BY sales DESC LIMIT 5;
    `, [start, end]);

    const topBrand = await this.dataSource.query(`
      SELECT p.brand, SUM(oi.qty) as sales
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
        AND o.created_at BETWEEN $1 AND $2
      GROUP BY p.brand
      ORDER BY sales DESC LIMIT 5;
    `, [start, end]);

    const deadStock = await this.dataSource.query(`
      SELECT p.id, p.model_name as name, p.brand, p.total_stock - p.locked_stock - p.sold_stock as available, p.created_at
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      WHERE p.created_at < NOW() - INTERVAL '90 days'
      AND oi.id IS NULL AND p.deleted_at IS NULL
      ORDER BY p.created_at ASC;
    `);

    return {
      topSellingProduct: topSeller[0] || null,
      topSellerList: topSeller,
      topBrand: topBrand[0]?.brand || null,
      topBrandList: topBrand,
      deadStockCount: deadStock.length,
      deadStock
    };
  }

  async getSplits() {
    const founders = ['Harshal', 'Anutosh', 'Sanchit', 'Anish'];
    const settings = await this.getGlobalSettings();
    const splits = settings.splits || {
      'Harshal': 25,
      'Anutosh': 25,
      'Sanchit': 25,
      'Anish': 25
    };

    const contrRows = await this.dataSource.query(`
      SELECT founder_name, SUM(amount)::float as total
      FROM cash_ledger
      WHERE type IN ('Founder Contribution', 'Founder Personal Inventory Purchase')
        AND status = 'Completed'
      GROUP BY founder_name;
    `);

    const paidMap = {};
    founders.forEach(f => paidMap[f] = 0);
    contrRows.forEach(r => {
      if (founders.includes(r.founder_name)) paidMap[r.founder_name] = r.total;
    });

    const totalExp = Object.values(paidMap).reduce((a: number, b: number) => a + b, 0) as number;

    const targetOwed = {};
    founders.forEach(f => {
      const pct = splits[f] || 25;
      targetOwed[f] = totalExp * (pct / 100);
    });

    const settlements = await this.dataSource.query(`
      SELECT * FROM cash_ledger
      WHERE type = 'Settlement Between Founders'
        AND status = 'Completed'
      ORDER BY date DESC;
    `);
    const sentMap = {};
    const recMap = {};
    founders.forEach(f => {
      sentMap[f] = 0;
      recMap[f] = 0;
    });

    settlements.forEach(s => {
      if (founders.includes(s.founder_name)) sentMap[s.founder_name] += Number(s.amount);
      if (founders.includes(s.to_founder)) recMap[s.to_founder] += Number(s.amount);
    });

    const balances = {};
    founders.forEach(f => {
      balances[f] = (paidMap[f] + recMap[f]) - (targetOwed[f] + sentMap[f]);
    });

    const owesWho = [];
    const debtors = founders.filter(f => balances[f] < -0.01).sort((a,b) => balances[a] - balances[b]);
    const creditors = founders.filter(f => balances[f] > 0.01).sort((a,b) => balances[b] - balances[a]);

    let dIdx = 0;
    let cIdx = 0;
    const balTmp = { ...balances };

    while (dIdx < debtors.length && cIdx < creditors.length) {
      const db = debtors[dIdx];
      const cr = creditors[cIdx];
      const dbOwes = Math.abs(balTmp[db]);
      const crNeeds = balTmp[cr];
      const amount = Math.min(dbOwes, crNeeds);
      
      owesWho.push({
        from: db,
        to: cr,
        amount: Number(amount.toFixed(2))
      });

      balTmp[db] += amount;
      balTmp[cr] -= amount;

      if (Math.abs(balTmp[db]) < 0.01) dIdx++;
      if (Math.abs(balTmp[cr]) < 0.01) cIdx++;
    }

    return {
      totalExpenses: totalExp,
      paidMap,
      targetOwed,
      balances,
      settlements,
      owesWho
    };
  }

  async getFounderLedger() {
    const founders = ['Harshal', 'Anutosh', 'Sanchit', 'Anish'];
    
    const contrRows = await this.dataSource.query(`
      SELECT founder_name, SUM(amount)::float as total
      FROM cash_ledger
      WHERE type IN ('Founder Contribution', 'Founder Personal Inventory Purchase')
        AND status = 'Completed'
      GROUP BY founder_name;
    `);
    const contrMap = {};
    founders.forEach(f => contrMap[f] = 0);
    contrRows.forEach(r => {
      if (founders.includes(r.founder_name)) contrMap[r.founder_name] = r.total;
    });

    const reimbRows = await this.dataSource.query(`
      SELECT founder_name, SUM(ABS(amount))::float as total
      FROM cash_ledger
      WHERE type = 'Founder Reimbursement'
        AND status = 'Completed'
      GROUP BY founder_name;
    `);
    const reimbMap = {};
    founders.forEach(f => reimbMap[f] = 0);
    reimbRows.forEach(r => {
      if (founders.includes(r.founder_name)) reimbMap[r.founder_name] = r.total;
    });

    const balances = {};
    founders.forEach(f => {
      balances[f] = contrMap[f] - reimbMap[f];
    });

    const timeline = await this.dataSource.query(`
      SELECT id, founder_name as "founderName", amount, type, reason, notes, date, created_at
      FROM cash_ledger
      WHERE type IN ('Founder Contribution', 'Founder Personal Inventory Purchase', 'Founder Reimbursement', 'Settlement Between Founders')
        AND status = 'Completed'
      ORDER BY date DESC, created_at DESC;
    `);

    return {
      founders,
      contributions: contrMap,
      reimbursements: reimbMap,
      balances,
      timeline
    };
  }

  async addFounderContribution(dto: { founderName: string; amount: number; cashAccountId: string; reason: string; notes?: string; date?: string }, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const dateVal = dto.date ? new Date(dto.date) : new Date();
      const res = await queryRunner.query(`
        INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, founder_name, date, created_by)
        VALUES ($1, $2, 'Founder Contribution', 'Completed', 'Founder Ledger', 'Contribution', $3, $4, $5, $6, $7)
        RETURNING id;
      `, [dto.cashAccountId, Number(dto.amount), dto.reason, dto.notes || '', dto.founderName, dateVal, adminEmail]);

      await this.writeAuditLog(
        'CREATE_FOUNDER_CONTRIBUTION',
        'cash_ledger',
        res[0].id,
        adminEmail,
        ipAddress,
        null,
        { founderName: dto.founderName, amount: dto.amount, cashAccountId: dto.cashAccountId }
      );

      await queryRunner.commitTransaction();
      return { success: true, id: res[0].id };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  async addFounderReimbursement(dto: { founderName: string; amount: number; cashAccountId: string; reason: string; notes?: string; date?: string }, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const dateVal = dto.date ? new Date(dto.date) : new Date();
      const res = await queryRunner.query(`
        INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, founder_name, date, created_by)
        VALUES ($1, $2, 'Founder Reimbursement', 'Completed', 'Founder Ledger', 'Reimbursement', $3, $4, $5, $6, $7)
        RETURNING id;
      `, [dto.cashAccountId, -Number(dto.amount), dto.reason, dto.notes || '', dto.founderName, dateVal, adminEmail]);

      await this.writeAuditLog(
        'CREATE_FOUNDER_REIMBURSEMENT',
        'cash_ledger',
        res[0].id,
        adminEmail,
        ipAddress,
        null,
        { founderName: dto.founderName, amount: dto.amount, cashAccountId: dto.cashAccountId }
      );

      await queryRunner.commitTransaction();
      return { success: true, id: res[0].id };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  async addSettlement(from: string, to: string, amount: number, notes: string, date: string) {
    const accounts = await this.getCashAccounts();
    const defaultAccId = accounts[0]?.id || null;

    await this.dataSource.query(`
      INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, founder_name, to_founder, date, created_by)
      VALUES ($1, $2, 'Settlement Between Founders', 'Completed', 'Founder Ledger', 'Settlement', $3, $4, $5, $6, $7, 'System');
    `, [defaultAccId, amount, `Settlement from ${from} to ${to}`, notes || '', from, to, date]);
    return { success: true };
  }

  // ── CMS SECTIONS SETTINGS CONFIGURATION ──────────────────────────
  async getHomepageCMS() {
    const sections = await this.dataSource.query("SELECT * FROM homepage_sections ORDER BY display_order ASC;");
    const items = await this.dataSource.query(`
      SELECT hi.id, hi.section_id as "sectionId", hi.product_id as "productId", hi.is_visible as "isVisible", hi.display_order as "displayOrder",
             p.model_name as name, p.brand, pi.thumbnail_url as image
      FROM homepage_items hi
      JOIN products p ON p.id = hi.product_id
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      ORDER BY hi.display_order ASC;
    `);
    return { sections, items };
  }

  async updateHomepageSectionVisibility(sectionName: string, isVisible: boolean) {
    await this.dataSource.query(
      "UPDATE homepage_sections SET is_visible = $1 WHERE section_name = $2",
      [isVisible, sectionName]
    );
    localCache.del('homepage_sections');
    return { success: true };
  }

  // ── AUDIT LOGS RETRIEVAL ───────────────────────────────────────────
  async getAuditLogs() {
    return this.dataSource.query(`
      SELECT id, action, entity, entity_id as "entityId", performed_by as "performedBy", ip_address as "ipAddress",
             before_state as "beforeState", after_state as "afterState", timestamp
      FROM audit_logs
      ORDER BY timestamp DESC LIMIT 200;
    `);
  }

    async getSystemNotifications(limit: number = 10, offset: number = 0) {
    return this.dataSource.query(
      "SELECT * FROM system_notifications ORDER BY created_at DESC LIMIT $1 OFFSET $2;",
      [limit, offset]
    );
  }

  async createSystemNotification(title: string, message: string, type: string = 'info', orderId: string | null = null) {
    await this.dataSource.query(`
      INSERT INTO system_notifications (title, message, type, order_id)
      VALUES ($1, $2, $3, $4);
    `, [title, message, type, orderId]);
  }

  async markNotificationsRead() {
    await this.dataSource.query("DELETE FROM system_notifications;");
    return { success: true };
  }

  async deleteSystemNotification(id: string) {
    await this.dataSource.query("DELETE FROM system_notifications WHERE id = $1;", [id]);
    return { success: true };
  }

  async getCustomerProfile(email: string) {
    const emailClean = email.trim().toLowerCase();
    const rows = await this.dataSource.query(`
      SELECT full_name as "fullName", phone, instagram, address, city
      FROM customers
      WHERE email = $1 AND deleted_at IS NULL;
    `, [emailClean]);
    if (rows.length === 0) {
      return { fullName: '', phone: '', instagram: '', address: '', city: 'Unknown' };
    }
    return rows[0];
  }

  async updateCustomerProfile(email: string, dto: any) {
    const emailClean = email.trim().toLowerCase();
    const { fullName, phone, instagram, address, city } = dto;
    const cleanPhone = phone ? phone.trim() : `unknown_${crypto.randomUUID()}`;
    const custRes = await this.dataSource.query(`
      INSERT INTO customers (full_name, phone, instagram, address, email, city)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE 
      SET full_name = EXCLUDED.full_name,
          phone = EXCLUDED.phone,
          instagram = EXCLUDED.instagram,
          address = EXCLUDED.address,
          city = EXCLUDED.city
      RETURNING full_name as "fullName", phone, instagram, address, email, city;
    `, [fullName || '', cleanPhone, instagram || '', address || '', emailClean, city || 'Unknown']);
    return custRes[0];
  }

  // ── SETTINGS Endpoints ─────────────────────────────────────────────
  async getGlobalSettings() {
    const rows = await this.dataSource.query("SELECT value FROM global_settings WHERE key = 'app_settings';");
    return rows.length > 0 ? rows[0].value : { 
      showPrices: true,
      instagramUrl: 'https://www.instagram.com/garagekingsindia/',
      companyUpiId: 'garagekings@upi',
      upiQrImage: '/upi-qr.png',
      partnerNames: ['Harshal', 'Anutosh', 'Sanchit', 'Anish'],
      splits: { 'Harshal': 25, 'Anutosh': 25, 'Sanchit': 25, 'Anish': 25 },
      lowStockThreshold: 3,
      reservationDuration: 15
    };
  }

  async updateGlobalSettings(settings: any, adminEmail: string, ipAddress: string) {
    const current = await this.getGlobalSettings();
    const merged = { ...current, ...settings };
    await this.dataSource.query(`
      INSERT INTO global_settings (key, value, updated_at)
      VALUES ('app_settings', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW();
    `, [merged]);
    
    await this.writeAuditLog(
      'UPDATE_SETTINGS',
      'settings',
      'app_settings',
      adminEmail,
      ipAddress,
      current,
      merged
    );

    return merged;
  }

  // Telemetry logging
  async logError(source: string, level: string, message: string, stack?: string, url?: string, userAgent?: string, userEmail?: string) {
    try {
      await this.dataSource.query(`
        INSERT INTO error_logs (source, level, message, stack, url, user_agent, user_email)
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `, [source, level, message, stack || null, url || null, userAgent || null, userEmail || null]);
      return { success: true };
    } catch (err) {
      console.error('Failed to log error to DB:', err);
      return { success: false };
    }
  }

  async getTelemetryLogs() {
    try {
      return await this.dataSource.query(`
        SELECT * FROM error_logs
        ORDER BY created_at DESC
        LIMIT 100;
      `);
    } catch (err) {
      console.error('Failed to fetch error logs from DB:', err);
      return [];
    }
  }

  // ── INVENTORY BATCH & LEDGER SYSTEM SERVICES ──────────────────────
  async createSupplier(body: any, adminEmail: string, ipAddress: string) {
    const name = (body.name || '').trim();
    if (!name) throw new Error('Supplier name is required');
    
    await this.dataSource.query(`
      INSERT INTO suppliers (name, contact_email, contact_phone, address)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (name) DO NOTHING;
    `, [name, body.contactEmail || null, body.contactPhone || null, body.address || null]);
    
    const dist = await this.dataSource.query("SELECT * FROM suppliers WHERE name = $1;", [name]);
    
    await this.writeAuditLog('CREATE_SUPPLIER', 'suppliers', dist[0].id, adminEmail, ipAddress, null, dist[0]);
    return dist[0];
  }

  async getSuppliers() {
    return this.dataSource.query("SELECT * FROM suppliers ORDER BY name ASC;");
  }

  async getProductBatches(productId: string) {
    return this.dataSource.query(`
      SELECT b.*, d.name as "distributorName"
      FROM inventory_batches b
      LEFT JOIN suppliers d ON d.id = b.supplier_id
      WHERE b.product_id = $1
      ORDER BY b.received_at DESC;
    `, [productId]);
  }

  async receiveInventoryBatchTx(
    queryRunner: any,
    productId: string,
    distributorName: string, // Can be supplier name or supplier UUID
    purchasePrice: number,
    sellingPrice: number,
    quantity: number,
    creatorEmail: string,
    ipAddress: string,
    fundedBy?: string,
    supplierPurchaseId?: string,
    purchaseReceiptId?: string,
    casingType?: string
  ) {
    // Resolve/seed supplier
    let distId = null;
    let distName = 'Default Supplier';

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (uuidRegex.test(distributorName)) {
      const distRes = await queryRunner.query("SELECT id, name FROM suppliers WHERE id = $1", [distributorName]);
      if (distRes.length > 0) {
        distId = distRes[0].id;
        distName = distRes[0].name;
      }
    } else {
      const distNameClean = (distributorName || 'Default Supplier').trim();
      const distRes = await queryRunner.query("SELECT id FROM suppliers WHERE name = $1", [distNameClean]);
      if (distRes.length > 0) {
        distId = distRes[0].id;
        distName = distNameClean;
      } else {
        const newDist = await queryRunner.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id;", [distNameClean]);
        distId = newDist[0].id;
        distName = distNameClean;
      }
    }

    // Get product SKU
    const prod = await queryRunner.query("SELECT sku FROM products WHERE id = $1;", [productId]);
    const sku = prod[0]?.sku || `SKU-MIG-${Date.now()}`;

    // Insert batch
    const batchRes = await queryRunner.query(`
      INSERT INTO inventory_batches (product_id, supplier_id, supplier_purchase_id, purchase_receipt_id, sku, purchase_price, selling_price, quantity_received, quantity_available, casing_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
      RETURNING id;
    `, [productId, distId, supplierPurchaseId || null, purchaseReceiptId || null, sku, Number(purchasePrice), Number(sellingPrice), Number(quantity), casingType || 'box']);
    const batchId = batchRes[0].id;

    // Record Inventory Purchase Cash Ledger entry (Skip if it's from a Supplier Purchase since payments are tracked separately)
    if (!supplierPurchaseId) {
      const accounts = await queryRunner.query("SELECT id FROM cash_accounts WHERE type = 'Bank' AND is_active = true LIMIT 1;");
      const cashAccountId = accounts[0]?.id || (await queryRunner.query("SELECT id FROM cash_accounts WHERE is_active = true LIMIT 1;"))[0]?.id;
      const totalCost = Number(quantity) * Number(purchasePrice);

      if (cashAccountId && totalCost > 0) {
        await queryRunner.query(`
          INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
          VALUES ($1, $2, 'Inventory Purchase', 'Completed', 'Inventory Batch', $3, $4, $5, NOW(), $6);
        `, [
          cashAccountId,
          -totalCost,
          batchId,
          `Inventory purchase: ${quantity} units of SKU ${sku}`,
          `Received from supplier ${distName}`,
          creatorEmail || 'System'
        ]);

        const founders = ['Harshal', 'Anutosh', 'Sanchit', 'Anish'];
        const fundSrc = (fundedBy || '').trim();
        if (founders.includes(fundSrc)) {
          await queryRunner.query(`
            INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, founder_name, date, created_by)
            VALUES ($1, $2, 'Founder Contribution', 'Completed', 'Founder Ledger', 'Contribution', $3, $4, $5, NOW(), $6);
          `, [
            cashAccountId,
            totalCost,
            batchId,
            `Founder Personal Purchase for batch: ${sku}`,
            `Founder ${fundSrc} paid personally for this batch`,
            fundSrc,
            creatorEmail || 'System'
          ]);
        }
      }
    }

    // Record ledger entry
    await queryRunner.query(`
      INSERT INTO inventory_ledger (product_id, batch_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
      VALUES ($1, $2, 'RECEIVE', $3, $4, $5, $6, $7);
    `, [productId, batchId, Number(quantity), Number(purchasePrice), Number(sellingPrice), `Received batch of ${quantity} units from ${distName}`, creatorEmail]);

    // Update products cache
    await queryRunner.query(`
      UPDATE products 
      SET total_stock = total_stock + $1,
          purchase_price = $2,
          selling_price = $3,
          base_price = $3,
          updated_at = NOW() 
      WHERE id = $4;
    `, [Number(quantity), Number(purchasePrice), Number(sellingPrice), productId]);

    // Update inventory cache
    await queryRunner.query(`
      INSERT INTO inventory (product_id, quantity_available)
      VALUES ($1, $2)
      ON CONFLICT (product_id) DO UPDATE SET quantity_available = inventory.quantity_available + $2;
    `, [productId, Number(quantity)]);

    // Chronological Pre-order Allocation Engine queueing
    const preorders = await queryRunner.query(`
      SELECT oi.id as "orderItemId", oi.qty, o.id as "orderId", o.created_at
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.booking_type = 'pre_order' AND o.status = 'Confirmed'
        AND NOT EXISTS (SELECT 1 FROM order_inventory_allocations WHERE order_item_id = oi.id)
      ORDER BY o.created_at ASC
      FOR UPDATE;
    `);

    let batchAvail = Number(quantity);
    for (const po of preorders) {
      if (batchAvail <= 0) break;
      const allocQty = Math.min(po.qty, batchAvail);

      // Create order_inventory_allocations
      await queryRunner.query(`
        INSERT INTO order_inventory_allocations (order_item_id, batch_id, quantity, purchase_price, selling_price)
        VALUES ($1, $2, $3, $4, $5);
      `, [po.orderItemId, batchId, allocQty, Number(purchasePrice), Number(sellingPrice)]);

      // Record in ledger
      await queryRunner.query(`
        INSERT INTO inventory_ledger (product_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
        VALUES ($1, $2, $3, 'RESERVE', $4, $5, $6, $7, $8);
      `, [productId, batchId, po.orderId, -allocQty, Number(purchasePrice), Number(sellingPrice), `Allocated pre-order for order item ${po.orderItemId}`, 'System/PreorderQueue']);

      // Update batch
      await queryRunner.query(`
        UPDATE inventory_batches
        SET quantity_available = quantity_available - $1,
            quantity_reserved = quantity_reserved + $1,
            status = CASE WHEN quantity_available - $1 = 0 THEN 'Fully Consumed'::VARCHAR ELSE 'Partially Used'::VARCHAR END,
            updated_at = NOW()
        WHERE id = $2;
      `, [allocQty, batchId]);

      // Update caches: deduct available and add to reserved
      await queryRunner.query(`
        UPDATE products
        SET locked_stock = locked_stock + $1,
            updated_at = NOW()
        WHERE id = $2;
      `, [allocQty, productId]);

      await queryRunner.query(`
        UPDATE inventory
        SET quantity_available = quantity_available - $1,
            quantity_reserved = quantity_reserved + $1,
            updated_at = NOW()
        WHERE product_id = $2;
      `, [allocQty, productId]);

      // Update order item purchase cost
      await queryRunner.query(`
        UPDATE order_items
        SET purchase_price_at_purchase = $1
        WHERE id = $2;
      `, [Number(purchasePrice), po.orderItemId]);

      batchAvail -= allocQty;
    }

    return batchId;
  }

  async receiveInventoryBatch(
    productId: string,
    distributorName: string,
    purchasePrice: number,
    sellingPrice: number,
    quantity: number,
    creatorEmail: string,
    ipAddress: string,
    fundedBy?: string,
    casingType?: string
  ) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const batchId = await this.receiveInventoryBatchTx(
        queryRunner,
        productId,
        distributorName,
        purchasePrice,
        sellingPrice,
        quantity,
        creatorEmail,
        ipAddress,
        fundedBy,
        null,
        null,
        casingType
      );
      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');
      return { success: true, batchId };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async adjustBatchInventory(batchId: string, quantityChange: number, type: string, reason: string, adminEmail: string, ipAddress: string) {
    const change = Number(quantityChange);
    if (!batchId || !change || isNaN(change)) {
      throw new Error('Valid batchId and quantityChange are required');
    }
    
    const allowedTypes = ['ADJUST_ADD', 'ADJUST_REMOVE', 'MARK_DAMAGED'];
    if (!allowedTypes.includes(type)) {
      throw new Error(`Adjustment type must be one of: ${allowedTypes.join(', ')}`);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const batchRes = await queryRunner.query("SELECT * FROM inventory_batches WHERE id = $1 FOR UPDATE;", [batchId]);
      if (batchRes.length === 0) throw new Error('Batch not found');
      const b = batchRes[0];

      let newAvail = Number(b.quantity_available);
      let newDamaged = Number(b.quantity_damaged);

      if (type === 'ADJUST_ADD') {
        newAvail += change;
      } else if (type === 'ADJUST_REMOVE') {
        if (newAvail < change) throw new Error('Insufficient available stock in batch to remove');
        newAvail -= change;
      } else if (type === 'MARK_DAMAGED') {
        if (newAvail < change) throw new Error('Insufficient available stock in batch to mark as damaged');
        newAvail -= change;
        newDamaged += change;
      }

      // 1. Update batch quantities
      await queryRunner.query(`
        UPDATE inventory_batches
        SET quantity_available = $1,
            quantity_damaged = $2,
            status = CASE WHEN $1 = 0 AND quantity_reserved = 0 THEN 'Fully Consumed'::VARCHAR ELSE status END,
            updated_at = NOW()
        WHERE id = $3;
      `, [newAvail, newDamaged, batchId]);

      // 2. Insert ledger movement entry
      const ledgerQtyChange = (type === 'ADJUST_ADD') ? change : -change;
      await queryRunner.query(`
        INSERT INTO inventory_ledger (product_id, batch_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `, [b.product_id, batchId, type, ledgerQtyChange, Number(b.purchase_price), Number(b.selling_price), reason || `Manual adjustment type ${type}`, adminEmail]);

      // 3. Update products and inventory caches
      const diffAvailable = ledgerQtyChange;
      const diffDamaged = (type === 'MARK_DAMAGED') ? change : 0;

      await queryRunner.query(`
        UPDATE products
        SET total_stock = total_stock + $1,
            updated_at = NOW()
        WHERE id = $2;
      `, [diffAvailable, b.product_id]);

      await queryRunner.query(`
        UPDATE inventory
        SET quantity_available = quantity_available + $1,
            quantity_damaged = quantity_damaged + $2,
            updated_at = NOW()
        WHERE product_id = $3;
      `, [diffAvailable, diffDamaged, b.product_id]);

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      await this.writeAuditLog(
        'ADJUST_INVENTORY',
        'inventory_batches',
        batchId,
        adminEmail,
        ipAddress,
        b,
        { quantity_available: newAvail, quantity_damaged: newDamaged, type, reason }
      );

      return { success: true };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async runInventoryReconciliation(performedBy = 'System') {
    console.log(`[Inventory] Running integrity reconciliation check triggered by ${performedBy}...`);
    try {
      const mismatches = [];
      
      // 1. Check if inventory cache matches batch totals
      const batchSums = await this.dataSource.query(`
        SELECT 
          product_id,
          SUM(quantity_available)::int as sum_available,
          SUM(quantity_reserved)::int as sum_reserved,
          SUM(quantity_sold)::int as sum_sold,
          SUM(quantity_returned)::int as sum_returned,
          SUM(quantity_damaged)::int as sum_damaged
        FROM inventory_batches
        GROUP BY product_id
      `);
      
      for (const bs of batchSums) {
        const inv = await this.dataSource.query("SELECT * FROM inventory WHERE product_id = $1", [bs.product_id]);
        if (inv.length === 0) {
          mismatches.push(`Product ID ${bs.product_id}: Inventory cache row missing.`);
          continue;
        }
        const i = inv[0];
        if (i.quantity_available !== bs.sum_available ||
            i.quantity_reserved !== bs.sum_reserved ||
            i.quantity_sold !== bs.sum_sold ||
            i.quantity_returned !== bs.sum_returned ||
            i.quantity_damaged !== bs.sum_damaged) {
          mismatches.push(`Product ID ${bs.product_id}: Cache mismatch. Cache (Avail:${i.quantity_available}, Res:${i.quantity_reserved}, Sold:${i.quantity_sold}) vs Batches (Avail:${bs.sum_available}, Res:${bs.sum_reserved}, Sold:${bs.sum_sold}).`);
        }
      }
      
      // 2. Check if batch totals match ledger sums
      const ledgerSums = await this.dataSource.query(`
        SELECT 
          batch_id,
          SUM(quantity_changed)::int as total_change
        FROM inventory_ledger
        GROUP BY batch_id
      `);
      
      for (const ls of ledgerSums) {
        const batch = await this.dataSource.query("SELECT id, quantity_received, quantity_available, quantity_reserved, quantity_sold, quantity_returned, quantity_damaged FROM inventory_batches WHERE id = $1", [ls.batch_id]);
        if (batch.length === 0) {
          mismatches.push(`Batch ID ${ls.batch_id}: Batch missing but exists in ledger.`);
          continue;
        }
        const b = batch[0];
        if (b.quantity_available !== ls.total_change) {
          mismatches.push(`Batch ID ${ls.batch_id}: Ledger mismatch. Batch Available:${b.quantity_available} vs Ledger Total Change:${ls.total_change}.`);
        }
      }
      
      if (mismatches.length > 0) {
        console.warn(`[Inventory Reconciliation] ❌ Inconsistencies detected!`, mismatches);
        await this.createSystemNotification(
          'Inventory Inconsistency Alert',
          `Reconciliation check failed with ${mismatches.length} mismatches. Details: ${mismatches.slice(0, 3).join(', ')}`,
          'critical'
        );
      } else {
        console.log(`[Inventory Reconciliation] ✔ All inventory matches perfectly.`);
      }
      
      await this.writeAuditLog(
        'RUN_RECONCILIATION',
        'inventory',
        'reconciler',
        performedBy,
        '127.0.0.1',
        null,
        { mismatchesCount: mismatches.length, mismatches }
      );
      
      return { success: mismatches.length === 0, mismatches };
    } catch (err: any) {
      console.error("[Inventory Reconciliation] Error executing check:", err);
      return { success: false, error: err.message };
    }
  }

  async getSupplierPurchases(page = 1, limit = 10, search = "") {
    const offset = (page - 1) * limit;
    const searchParam = `%${search}%`;

    const countRes = await this.dataSource.query(`
      SELECT COUNT(*)::int as count 
      FROM supplier_purchases sp
      JOIN suppliers s ON s.id = sp.supplier_id
      WHERE s.name ILIKE $1 OR sp.notes ILIKE $1;
    `, [searchParam]);
    const total = countRes[0]?.count || 0;

    const purchases = await this.dataSource.query(`
      SELECT sp.id, sp.purchase_date as "purchaseDate", sp.expected_arrival_date as "expectedArrivalDate",
             sp.status, sp.total_value as "totalValue", sp.notes, sp.created_at as "createdAt",
             s.name as "supplierName",
             COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0)::float as "advancePaid",
             (sp.total_value - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0))::float as "remainingBalance",
             CASE 
               WHEN sp.status = 'Cancelled' AND EXISTS (SELECT 1 FROM cash_ledger WHERE type = 'Supplier Refund' AND source_type = 'Order' AND source_id = sp.id::varchar) THEN 'Refunded'::varchar
               WHEN COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0) >= sp.total_value THEN 'Fully Paid'::varchar
               WHEN COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0) > 0 THEN 'Partially Paid'::varchar
               ELSE 'Unpaid'::varchar
             END as "paymentStatus"
      FROM supplier_purchases sp
      JOIN suppliers s ON s.id = sp.supplier_id
      WHERE s.name ILIKE $1 OR sp.notes ILIKE $1
      ORDER BY sp.purchase_date DESC, sp.created_at DESC
      LIMIT $2 OFFSET $3;
    `, [searchParam, limit, offset]);

    return {
      purchases,
      total,
      totalPages: Math.ceil(total / limit)
    };
  }

  async getSupplierPurchaseDetails(id: string) {
    const purchaseRes = await this.dataSource.query(`
      SELECT sp.id, sp.purchase_date as "purchaseDate", sp.expected_arrival_date as "expectedArrivalDate",
             sp.status, sp.total_value as "totalValue", sp.notes, sp.created_at as "createdAt",
             s.name as "supplierName", s.id as "supplierId",
             COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0)::float as "advancePaid",
             (sp.total_value - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0))::float as "remainingBalance",
             CASE 
               WHEN sp.status = 'Cancelled' AND EXISTS (SELECT 1 FROM cash_ledger WHERE type = 'Supplier Refund' AND source_type = 'Order' AND source_id = sp.id::varchar) THEN 'Refunded'::varchar
               WHEN COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0) >= sp.total_value THEN 'Fully Paid'::varchar
               WHEN COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0) > 0 THEN 'Partially Paid'::varchar
               ELSE 'Unpaid'::varchar
             END as "paymentStatus"
      FROM supplier_purchases sp
      JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.id = $1;
    `, [id]);
    if (purchaseRes.length === 0) throw new BadRequestException('Supplier Purchase not found');
    const purchase = purchaseRes[0];

    const items = await this.dataSource.query(`
      SELECT spi.id, spi.product_id as "productId", spi.quantity, spi.purchase_price as "purchasePrice",
             p.model_name as "name", p.brand, p.scale, p.sku, spi.casing_type as "casingType",
             COALESCE((
               SELECT SUM(spri.quantity_received)::int 
               FROM supplier_purchase_receipt_items spri
               JOIN supplier_purchase_receipts spr ON spr.id = spri.purchase_receipt_id
               WHERE spr.supplier_purchase_id = spi.supplier_purchase_id AND spri.product_id = spi.product_id AND spri.casing_type = spi.casing_type
             ), 0) as "receivedQuantity"
      FROM supplier_purchase_items spi
      JOIN products p ON p.id = spi.product_id
      WHERE spi.supplier_purchase_id = $1;
    `, [id]);

    const payments = await this.dataSource.query(`
      SELECT sp.id, sp.amount, sp.payment_date as "paymentDate", sp.payment_method as "paymentMethod",
             sp.reference_number as "referenceNumber", sp.notes, sp.created_by as "createdBy", sp.created_at as "createdAt",
             ca.name as "cashAccountName"
      FROM supplier_payments sp
      JOIN cash_accounts ca ON ca.id = sp.cash_account_id
      WHERE sp.supplier_purchase_id = $1 
      ORDER BY sp.payment_date DESC, sp.created_at DESC;
    `, [id]);

    const receipts = await this.dataSource.query(`
      SELECT spr.id, spr.receipt_number as "receiptNumber", spr.received_date as "receivedDate", 
             spr.received_by as "receivedBy", spr.notes, spr.created_at as "createdAt",
             COALESCE((SELECT SUM(quantity_received) FROM supplier_purchase_receipt_items WHERE purchase_receipt_id = spr.id), 0)::int as "totalReceived"
      FROM supplier_purchase_receipts spr
      WHERE spr.supplier_purchase_id = $1
      ORDER BY spr.received_date DESC, spr.created_at DESC;
    `, [id]);

    const attachments = await this.dataSource.query(`
      SELECT * FROM supplier_purchase_attachments WHERE supplier_purchase_id = $1 ORDER BY uploaded_at DESC;
    `, [id]);

    return {
      ...purchase,
      items,
      payments,
      receipts,
      attachments
    };
  }

  async addSupplierPurchase(dto: any, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let totalValue = 0;
      for (const item of dto.items) {
        totalValue += Number(item.quantity) * Number(item.purchasePrice);
      }

      const purchaseRes = await queryRunner.query(`
        INSERT INTO supplier_purchases (supplier_id, purchase_date, expected_arrival_date, status, total_value, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
      `, [
        dto.supplierId, 
        dto.purchaseDate || new Date().toISOString().split('T')[0], 
        dto.expectedArrivalDate || null,
        Number(dto.advancePaid || 0) > 0 ? 'Awaiting Advance' : 'Draft', 
        totalValue, 
        dto.notes || null
      ]);
      const purchase = purchaseRes[0];

      for (const item of dto.items) {
        await queryRunner.query(`
          INSERT INTO supplier_purchase_items (supplier_purchase_id, product_id, quantity, purchase_price, casing_type)
          VALUES ($1, $2, $3, $4, $5);
        `, [purchase.id, item.productId, Number(item.quantity), Number(item.purchasePrice), item.casingType || 'box']);
      }

      if (Number(dto.advancePaid || 0) > 0) {
        if (!dto.cashAccountId) throw new Error("cashAccountId is required for advance payment");

        await queryRunner.query(`
          INSERT INTO supplier_payments (supplier_purchase_id, amount, payment_date, cash_account_id, payment_method, reference_number, notes, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `, [
          purchase.id, 
          Number(dto.advancePaid), 
          dto.purchaseDate || new Date().toISOString().split('T')[0], 
          dto.cashAccountId, 
          dto.paymentMethod || 'Bank Transfer', 
          dto.referenceNumber || null, 
          'Initial Booking Advance', 
          adminEmail
        ]);

        const accounts = await queryRunner.query("SELECT name FROM cash_accounts WHERE id = $1;", [dto.cashAccountId]);
        const accountName = accounts[0]?.name || 'Unknown Account';

        await queryRunner.query(`
          INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reference_number, reason, date, created_by)
          VALUES ($1, $2, 'Inventory Purchase', 'Completed', 'Order', $3, $4, $5, $6, $7);
        `, [
          dto.cashAccountId, 
          -Number(dto.advancePaid), 
          purchase.id.toString(), 
          dto.referenceNumber || null, 
          `Supplier Booking Advance via ${accountName}`, 
          dto.purchaseDate || new Date().toISOString().split('T')[0], 
          adminEmail
        ]);

        await queryRunner.query(`
          UPDATE supplier_purchases SET status = 'Booked' WHERE id = $1;
        `, [purchase.id]);
        
        purchase.status = 'Booked';
      }

      await queryRunner.commitTransaction();

      await this.writeAuditLog(
        'CREATE_SUPPLIER_PURCHASE',
        'supplier_purchases',
        purchase.id,
        adminEmail,
        ipAddress,
        null,
        purchase
      );

      return { success: true, id: purchase.id };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async recordSupplierPayment(purchaseId: string, dto: any, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const purchaseRes = await queryRunner.query("SELECT * FROM supplier_purchases WHERE id = $1 FOR UPDATE;", [purchaseId]);
      if (purchaseRes.length === 0) throw new Error('Supplier Purchase not found');
      const purchase = purchaseRes[0];

      if (purchase.status === 'Draft' || purchase.status === 'Cancelled' || purchase.status === 'Completed') {
        throw new Error(`Cannot record payment for purchase in status: ${purchase.status}`);
      }

      await queryRunner.query(`
        INSERT INTO supplier_payments (supplier_purchase_id, amount, payment_date, cash_account_id, payment_method, reference_number, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `, [
        purchaseId, 
        Number(dto.amount), 
        dto.date || new Date().toISOString().split('T')[0], 
        dto.cashAccountId, 
        dto.paymentMethod || 'Bank Transfer', 
        dto.referenceNumber || null, 
        dto.notes || 'Settlement Balance Payment', 
        adminEmail
      ]);

      const accounts = await queryRunner.query("SELECT name FROM cash_accounts WHERE id = $1;", [dto.cashAccountId]);
      const accountName = accounts[0]?.name || 'Unknown Account';

      await queryRunner.query(`
        INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reference_number, reason, date, created_by)
        VALUES ($1, $2, 'Inventory Purchase', 'Completed', 'Order', $3, $4, $5, $6, $7);
      `, [
        dto.cashAccountId, 
        -Number(dto.amount), 
        purchaseId, 
        dto.referenceNumber || null, 
        `Supplier Settlement Payment via ${accountName}`, 
        dto.date || new Date().toISOString().split('T')[0], 
        adminEmail
      ]);

      const paymentsSumRes = await queryRunner.query("SELECT SUM(amount)::float as total FROM supplier_payments WHERE supplier_purchase_id = $1;", [purchaseId]);
      const totalPaid = paymentsSumRes[0]?.total || 0;
      
      const orderedItems = await queryRunner.query("SELECT product_id, SUM(quantity)::int as ordered FROM supplier_purchase_items WHERE supplier_purchase_id = $1 GROUP BY product_id;", [purchaseId]);
      const receivedItems = await queryRunner.query(`
        SELECT spri.product_id, SUM(spri.quantity_received)::int as received 
        FROM supplier_purchase_receipt_items spri
        JOIN supplier_purchase_receipts spr ON spr.id = spri.purchase_receipt_id
        WHERE spr.supplier_purchase_id = $1
        GROUP BY spri.product_id;
      `, [purchaseId]);

      let isFullyReceived = true;
      for (const ordered of orderedItems) {
        const received = receivedItems.find(r => r.product_id === ordered.product_id)?.received || 0;
        if (received < ordered.ordered) {
          isFullyReceived = false;
          break;
        }
      }

      if (totalPaid >= Number(purchase.total_value) && isFullyReceived) {
        await queryRunner.query("UPDATE supplier_purchases SET status = 'Completed', updated_at = NOW() WHERE id = $1;", [purchaseId]);
      } else if (purchase.status === 'Awaiting Advance' && totalPaid > 0) {
        await queryRunner.query("UPDATE supplier_purchases SET status = 'Booked', updated_at = NOW() WHERE id = $1;", [purchaseId]);
      }

      await queryRunner.commitTransaction();

      await this.writeAuditLog(
        'RECORD_SUPPLIER_PAYMENT',
        'supplier_payments',
        purchaseId,
        adminEmail,
        ipAddress,
        null,
        { amount: dto.amount, totalPaid }
      );

      return { success: true };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async receiveSupplierShipment(purchaseId: string, dto: any, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const purchaseRes = await queryRunner.query("SELECT * FROM supplier_purchases WHERE id = $1 FOR UPDATE;", [purchaseId]);
      if (purchaseRes.length === 0) throw new Error('Supplier Purchase not found');
      const purchase = purchaseRes[0];

      if (purchase.status === 'Draft' || purchase.status === 'Cancelled' || purchase.status === 'Completed') {
        throw new Error(`Cannot receive stock for purchase in status: ${purchase.status}`);
      }

      const countRes = await queryRunner.query("SELECT COUNT(*)::int as count FROM supplier_purchase_receipts;");
      const receiptCount = countRes[0].count + 1;
      const receiptNumber = `PR-${new Date().getFullYear()}-${String(receiptCount).padStart(4, '0')}`;

      const receiptRes = await queryRunner.query(`
        INSERT INTO supplier_purchase_receipts (supplier_purchase_id, receipt_number, received_date, received_by, notes)
        VALUES ($1, $2, CURRENT_DATE, $3, $4)
        RETURNING *;
      `, [purchaseId, receiptNumber, dto.receivedBy || adminEmail, dto.notes || null]);
      const receiptId = receiptRes[0].id;

      for (const item of dto.items) {
        const productId = item.productId;
        const qtyReceived = Number(item.quantityReceived || 0);
        const qtyDamaged = Number(item.quantityDamaged || 0);
        const qtyShort = Number(item.quantityShort || 0);
        const qtyOver = Number(item.quantityOver || 0);

        await queryRunner.query(`
          INSERT INTO supplier_purchase_receipt_items (purchase_receipt_id, product_id, quantity_received, quantity_short, quantity_damaged, quantity_over, casing_type)
          VALUES ($1, $2, $3, $4, $5, $6, $7);
        `, [receiptId, productId, qtyReceived, qtyShort, qtyDamaged, qtyOver, item.casingType || 'box']);

        const orderItemRes = await queryRunner.query("SELECT purchase_price FROM supplier_purchase_items WHERE supplier_purchase_id = $1 AND product_id = $2 AND casing_type = $3;", [purchaseId, productId, item.casingType || 'box']);
        const purchasePrice = orderItemRes[0]?.purchase_price || 0;

        const productRes = await queryRunner.query("SELECT selling_price, base_price, sku FROM products WHERE id = $1;", [productId]);
        const sellingPrice = productRes[0]?.selling_price || productRes[0]?.base_price || 0;

        if (qtyReceived > 0) {
          await this.receiveInventoryBatchTx(
            queryRunner,
            productId,
            purchase.supplier_id,
            Number(purchasePrice),
            Number(sellingPrice),
            qtyReceived,
            adminEmail,
            ipAddress,
            null,
            purchaseId,
            receiptId,
            item.casingType || 'box'
          );
        }

        if (qtyDamaged > 0) {
          await queryRunner.query(`
            UPDATE inventory
            SET quantity_damaged = quantity_damaged + $1,
                updated_at = NOW()
            WHERE product_id = $2;
          `, [qtyDamaged, productId]);
        }
      }

      const orderedItems = await queryRunner.query("SELECT product_id, SUM(quantity)::int as ordered FROM supplier_purchase_items WHERE supplier_purchase_id = $1 GROUP BY product_id;", [purchaseId]);
      const receivedItems = await queryRunner.query(`
        SELECT spri.product_id, SUM(spri.quantity_received)::int as received 
        FROM supplier_purchase_receipt_items spri
        JOIN supplier_purchase_receipts spr ON spr.id = spri.purchase_receipt_id
        WHERE spr.supplier_purchase_id = $1
        GROUP BY spri.product_id;
      `, [purchaseId]);

      let isFullyReceived = true;
      for (const ordered of orderedItems) {
        const received = receivedItems.find(r => r.product_id === ordered.product_id)?.received || 0;
        if (received < ordered.ordered) {
          isFullyReceived = false;
          break;
        }
      }

      const newStatus = isFullyReceived ? 'Fully Received' : 'Partially Received';
      await queryRunner.query("UPDATE supplier_purchases SET status = $1, updated_at = NOW() WHERE id = $2;", [newStatus, purchaseId]);

      const paymentsSumRes = await queryRunner.query("SELECT SUM(amount)::float as total FROM supplier_payments WHERE supplier_purchase_id = $1;", [purchaseId]);
      const totalPaid = paymentsSumRes[0]?.total || 0;
      if (isFullyReceived && totalPaid >= Number(purchase.total_value)) {
        await queryRunner.query("UPDATE supplier_purchases SET status = 'Completed', updated_at = NOW() WHERE id = $1;", [purchaseId]);
      }

      await queryRunner.commitTransaction();
      
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      await this.writeAuditLog(
        'RECEIVE_SUPPLIER_SHIPMENT',
        'supplier_purchase_receipts',
        receiptId,
        adminEmail,
        ipAddress,
        null,
        { receiptNumber, isFullyReceived }
      );

      return { success: true, receiptNumber };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async getSupplierMetrics() {
    const upcomingRes = await this.dataSource.query(`
      SELECT COUNT(*)::int as count FROM supplier_purchases
      WHERE status IN ('Booked', 'In Transit', 'Partially Received')
        AND expected_arrival_date >= CURRENT_DATE;
    `);
    const upcomingArrivals = upcomingRes[0]?.count || 0;

    const outstandingRes = await this.dataSource.query(`
      SELECT (
        COALESCE((SELECT SUM(total_value) FROM supplier_purchases WHERE status != 'Cancelled' AND status != 'Completed'), 0) -
        COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id IN (
          SELECT id FROM supplier_purchases WHERE status != 'Cancelled' AND status != 'Completed'
        )), 0)
      )::float as total;
    `);
    const outstandingPayables = outstandingRes[0]?.total || 0;

    const awaitingRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(spi.quantity - COALESCE(
        (SELECT SUM(spri.quantity_received) 
         FROM supplier_purchase_receipt_items spri
         JOIN supplier_purchase_receipts spr ON spr.id = spri.purchase_receipt_id
         WHERE spr.supplier_purchase_id = spi.supplier_purchase_id AND spri.product_id = spi.product_id), 0
      )), 0)::int as total
      FROM supplier_purchase_items spi
      JOIN supplier_purchases sp ON sp.id = spi.supplier_purchase_id
      WHERE sp.status IN ('Booked', 'In Transit', 'Partially Received');
    `);
    const awaitingReceiptCount = awaitingRes[0]?.total || 0;

    const delayedRes = await this.dataSource.query(`
      SELECT COUNT(*)::int as count FROM supplier_purchases
      WHERE status IN ('Booked', 'In Transit', 'Partially Received')
        AND expected_arrival_date < CURRENT_DATE;
    `);
    const delayedShipments = delayedRes[0]?.count || 0;

    const spendRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM supplier_payments;
    `);
    const totalSpend = spendRes[0]?.total || 0;

    const leadTimeRes = await this.dataSource.query(`
      SELECT COALESCE(AVG(spr.received_date - sp.purchase_date), 0)::float as avg_days
      FROM supplier_purchase_receipts spr
      JOIN supplier_purchases sp ON sp.id = spr.supplier_purchase_id;
    `);
    const avgLeadTimeDays = Math.round(leadTimeRes[0]?.avg_days || 0);

    const timeline = await this.dataSource.query(`
      SELECT sp.id, s.name as "supplierName", sp.purchase_date as "purchaseDate", sp.expected_arrival_date as "expectedArrivalDate",
             sp.status, sp.total_value as "totalValue",
             COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_purchase_id = sp.id), 0)::float as "advancePaid"
      FROM supplier_purchases sp
      JOIN suppliers s ON s.id = sp.supplier_id
      ORDER BY sp.purchase_date DESC, sp.created_at DESC
      LIMIT 10;
    `);

    return {
      upcomingArrivals,
      outstandingPayables,
      awaitingReceiptCount,
      delayedShipments,
      totalSpend,
      avgLeadTimeDays,
      timeline
    };
  }

  async updateSupplierPurchaseStatus(purchaseId: string, status: string, adminEmail: string, ipAddress: string) {
    const validStates = ['Draft', 'Awaiting Advance', 'Booked', 'In Transit', 'Partially Received', 'Fully Received', 'Completed', 'Cancelled'];
    if (!validStates.includes(status)) throw new Error('Invalid purchase status');

    const purchaseRes = await this.dataSource.query("SELECT * FROM supplier_purchases WHERE id = $1;", [purchaseId]);
    if (purchaseRes.length === 0) throw new Error('Supplier Purchase not found');
    const old = purchaseRes[0];

    // Handle cancellation refund if cancelled
    if (status === 'Cancelled' && old.status !== 'Cancelled') {
      const paymentsSumRes = await this.dataSource.query("SELECT SUM(amount)::float as total FROM supplier_payments WHERE supplier_purchase_id = $1;", [purchaseId]);
      const totalPaid = paymentsSumRes[0]?.total || 0;
      if (totalPaid > 0) {
        // Log refund notification
        await this.createSystemNotification(
          'Supplier Purchase Cancelled',
          `Purchase order from supplier was cancelled. Outstanding advance refund required: ₹${totalPaid}`,
          'warning'
        );
      }
    }

    await this.dataSource.query("UPDATE supplier_purchases SET status = $1, updated_at = NOW() WHERE id = $2;", [status, purchaseId]);
    
    await this.writeAuditLog(
      'UPDATE_SUPPLIER_PURCHASE_STATUS',
      'supplier_purchases',
      purchaseId,
      adminEmail,
      ipAddress,
      old,
      { status }
    );
    return { success: true };
  }

  async addSupplierPurchaseAttachment(purchaseId: string, fileBuffer: Buffer, fileName: string, fileExtension: string, adminEmail: string) {
    const generatedName = `${crypto.randomUUID()}.${fileExtension}`;
    if (process.env.S3_ASSETS_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET,
          Key: `attachments/${generatedName}`,
          Body: fileBuffer,
          ContentType: fileExtension === 'pdf' ? 'application/pdf' : `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`
        }));
      } catch (err: any) {
        console.error(`[S3] Failed to upload attachment: ${err.message}`);
        throw err;
      }
    } else {
      const filePath = path.join(privateUploadDir, generatedName);
      fs.writeFileSync(filePath, fileBuffer);
    }

    const result = await this.dataSource.query(`
      INSERT INTO supplier_purchase_attachments (supplier_purchase_id, file_name, file_path, uploaded_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `, [purchaseId, fileName, generatedName, adminEmail]);

    return result[0];
  }

  async getSupplierAttachmentStream(attachmentId: string) {
    const rows = await this.dataSource.query(
      "SELECT file_name, file_path FROM supplier_purchase_attachments WHERE id = $1", 
      [attachmentId]
    );
    if (rows.length === 0) return null;
    
    const generatedName = rows[0].file_path;
    const originalName = rows[0].file_name;

    if (process.env.S3_ASSETS_BUCKET) {
      try {
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const res = await s3.send(new GetObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET,
          Key: `attachments/${generatedName}`
        }));
        return {
          stream: res.Body as any,
          filename: originalName
        };
      } catch (err: any) {
        console.error(`[S3] Failed to download attachment: ${err.message}`);
        throw err;
      }
    } else {
      const filePath = path.join(privateUploadDir, generatedName);
      if (!fs.existsSync(filePath)) return null;
      return {
        stream: fs.createReadStream(filePath),
        filename: originalName
      };
    }
  }
}
export default ApiService;
