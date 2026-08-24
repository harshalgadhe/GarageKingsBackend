import { Injectable, OnModuleInit, UnauthorizedException, BadRequestException, ConflictException, HttpException, HttpStatus, ForbiddenException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
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
  private lastCleanupAt = 0;
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

    // Schema changes and scheduled maintenance belong in migrations/workers,
    // not Lambda cold starts. Running them in every concurrent container can
    // occupy the single serverless database connection and starve requests.
    if (process.env.RUN_LEGACY_STARTUP_MAINTENANCE !== 'true') {
      console.log('[onModuleInit] Schema bootstrap and reconciliation skipped. Use versioned migrations and explicit maintenance jobs.');
      return;
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
    for (const val of ['Verification Pending', 'Confirmed', 'Reserved', 'Pre-Order', 'Awaiting Stock', 'Expired', 'Awaiting Screenshot', 'Awaiting Confirmation', 'Packed', 'Shipped', 'Delivered', 'Cancelled', 'Rejected']) {
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
      ALTER TABLE products ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

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

    // DDL migrations for cart, versioning, idempotency, payment receipts and audit event trails
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS carts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cart_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
          variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
          quantity INT NOT NULL CHECK (quantity > 0),
          product_name_snapshot VARCHAR(255),
          image_snapshot VARCHAR(512),
          price_snapshot NUMERIC(12,2),
          brand_snapshot VARCHAR(100),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          deleted_at TIMESTAMP WITH TIME ZONE,
          UNIQUE(cart_id, variant_id)
      );

      ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

      CREATE TABLE IF NOT EXISTS idempotency_keys (
          key VARCHAR(255) PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint VARCHAR(255) NOT NULL,
          resource_type VARCHAR(100) NOT NULL,
          resource_id UUID NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_payment_receipts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          screenshot_url VARCHAR(255) NOT NULL,
          file_hash VARCHAR(64) UNIQUE NOT NULL,
          status VARCHAR(50) DEFAULT 'Pending',
          uploaded_by UUID NOT NULL REFERENCES users(id),
          uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS order_events (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          event_type VARCHAR(100) NOT NULL,
          previous_status VARCHAR(50),
          new_status VARCHAR(50),
          details TEXT,
          performed_by VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS payment_events (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          event_type VARCHAR(100) NOT NULL,
          receipt_id UUID REFERENCES order_payment_receipts(id) ON DELETE SET NULL,
          details TEXT,
          performed_by VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reconciliations (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
          system_count INT NOT NULL,
          actual_count INT NOT NULL,
          variance INT NOT NULL,
          notes TEXT,
          created_by VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // ── AUDIT LOGGING SYSTEM (IMMUTABLE LOGS) ──────────────────────────
  async writeAuditLog(action: string, entity: string, entityId: string, performedBy: string, ipAddress: string, before: any, after: any, queryRunner?: QueryRunner) {
    try {
      const executor = queryRunner || this.dataSource;
      await executor.query(`
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
    if (!/^\S+@\S+\.\S+$/.test(emailClean)) {
      throw new BadRequestException('Enter a valid email address.');
    }
    if (pass.length < 8 || !/[a-z]/.test(pass) || !/[A-Z]/.test(pass) || !/\d/.test(pass)) {
      throw new BadRequestException('Password must contain at least 8 characters, including uppercase, lowercase and a number.');
    }
    const existing = await this.dataSource.query("SELECT id FROM users WHERE email = $1", [emailClean]);
    if (existing.length > 0) {
      throw new BadRequestException('Email address already registered.');
    }
    const hash = hashPassword(pass);
    const targetRole = 'Collector';
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
      return { id: user.id, email: user.email, role: user.role };
    }
    return null;
  }

  async getRecentFailedLoginCount(email: string) {
    const rows = await this.dataSource.query(`
      SELECT COUNT(*)::int AS count
      FROM audit_logs
      WHERE action = 'LOGIN_FAILED'
        AND entity = 'Authentication'
        AND LOWER(performed_by) = LOWER($1)
        AND timestamp > NOW() - INTERVAL '15 minutes';
    `, [email.trim()]);
    return Number(rows[0]?.count || 0);
  }

  async recordFailedLogin(email: string, ipAddress = 'unknown') {
    await this.writeAuditLog('LOGIN_FAILED', 'Authentication', '00000000-0000-0000-0000-000000000000', email.trim().toLowerCase(), ipAddress, null, null);
  }

  async syncGoogleUser(email: string, pass: string) {
    const hash = hashPassword(pass);
    const emailClean = email.trim().toLowerCase();
    const existing = await this.dataSource.query("SELECT id, role, password_hash FROM users WHERE email = $1", [emailClean]);
    
    const targetRole = 'Collector';
    
    if (existing.length > 0) {
      await this.dataSource.query("UPDATE users SET password_hash = $1 WHERE email = $2", [hash, emailClean]);
      return { id: existing[0].id, email: emailClean, role: existing[0].role };
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
    await this.dataSource.query(`
      UPDATE users
      SET refresh_token_hash = $1,
          refresh_token_previous_hash = NULL,
          refresh_token_rotated_at = NULL
      WHERE id = $2
    `, [hash, userId]);
  }

  async verifyRefreshToken(userId: string, token: string): Promise<'current' | 'previous' | null> {
    const rows = await this.dataSource.query(`
      SELECT refresh_token_hash, refresh_token_previous_hash, refresh_token_rotated_at
      FROM users
      WHERE id = $1 AND deleted_at IS NULL
    `, [userId]);
    if (rows.length === 0 || !rows[0].refresh_token_hash) return null;
    const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
    const matches = (storedValue: unknown) => {
      if (!storedValue) return false;
      const storedHash = String(storedValue);
      return expectedHash.length === storedHash.length
        && crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(storedHash));
    };

    if (matches(rows[0].refresh_token_hash)) return 'current';

    const rotatedAt = rows[0].refresh_token_rotated_at
      ? new Date(rows[0].refresh_token_rotated_at).getTime()
      : 0;
    if (Date.now() - rotatedAt <= 60_000 && matches(rows[0].refresh_token_previous_hash)) {
      return 'previous';
    }
    return null;
  }

  async rotateRefreshToken(userId: string, currentToken: string, newToken: string): Promise<boolean> {
    const currentHash = crypto.createHash('sha256').update(currentToken).digest('hex');
    const newHash = crypto.createHash('sha256').update(newToken).digest('hex');
    const result = await this.dataSource.query(`
      UPDATE users
      SET refresh_token_previous_hash = refresh_token_hash,
          refresh_token_hash = $1,
          refresh_token_rotated_at = NOW()
      WHERE id = $2
        AND refresh_token_hash = $3
        AND deleted_at IS NULL
      RETURNING id
    `, [newHash, userId, currentHash]);
    return result.length > 0;
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
             COALESCE(
               p.available_stock,
               p.stock,
               p.total_stock - COALESCE(p.locked_stock, 0) - COALESCE(p.sold_stock, 0),
               p.total_stock,
               0
             )::int as "availableStock",
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

  async getAdminVariants(options: { page?: number; limit?: number; search?: string }) {
    const page = Math.max(1, Number(options.page || 1));
    const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
    const offset = (page - 1) * limit;

    let filterStr = "WHERE pv.deleted_at IS NULL";
    const params = [];
    if (options.search) {
      filterStr += ` AND (pv.name ILIKE $1 OR p.sku ILIKE $1 OR p.model_name ILIKE $1)`;
      params.push(`%${options.search}%`);
    }

    const countRes = await this.dataSource.query(`
      SELECT COUNT(DISTINCT pv.id) as count
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      ${filterStr};
    `, params);
    const total = Number(countRes[0]?.count || 0);
    const totalPages = Math.ceil(total / limit);

    const queryParams = [...params];
    const pageIndex = queryParams.length + 1;
    queryParams.push(limit);
    queryParams.push(offset);

    const variants = await this.dataSource.query(`
      SELECT 
        pv.id,
        p.sku,
        pv.barcode,
        pv.name,
        pv.selling_price as "selling_price",
        pv.status,
        pv.visibility,
        pv.sales_status as "salesStatus",
        p.model_name as "productName",
        COALESCE(SUM(ib.quantity_available), 0)::INT as "quantity_available",
        COALESCE(SUM(ib.quantity_reserved), 0)::INT as "quantity_reserved",
        COALESCE(SUM(ib.quantity_sold), 0)::INT as "quantity_sold",
        (
          SELECT COALESCE(GREATEST(0, SUM(spi.quantity) - COALESCE(
            (
              SELECT SUM(ib_rec.quantity_received)
              FROM inventory_batches ib_rec
              JOIN supplier_purchases sp_rec ON sp_rec.id = ib_rec.supplier_purchase_id
              WHERE sp_rec.status NOT IN ('Draft', 'Cancelled', 'Completed')
                AND ib_rec.status != 'Archived'
                AND ib_rec.variant_id = pv.id
            ), 0
          )), 0)::INT
          FROM supplier_purchase_items spi
          JOIN supplier_purchases sp ON sp.id = spi.supplier_purchase_id
          WHERE spi.variant_id = pv.id
            AND sp.status NOT IN ('Draft', 'Cancelled', 'Completed')
        ) as "quantity_incoming",
        COALESCE(SUM(ib.quantity_damaged), 0)::INT as "quantity_damaged",
        COALESCE(SUM(ib.quantity_returned), 0)::INT as "quantity_returned",
        COALESCE(AVG(ib.purchase_price), 0.00)::NUMERIC(12,2) as "avgCost",
        COUNT(ib.id)::INT as "batchCount",
        COALESCE(SUM(ib.quantity_available * ib.purchase_price), 0.00)::NUMERIC(12,2) as "inventory_value"
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN inventory_batches ib ON ib.variant_id = pv.id AND ib.status != 'Archived'
      ${filterStr}
      GROUP BY pv.id, p.model_name
      ORDER BY pv.created_at DESC
      LIMIT $${pageIndex} OFFSET $${pageIndex + 1};
    `, queryParams);

    return {
      variants,
      total,
      totalPages,
      page
    };
  }

  async getHomepageProducts() {
    const cacheKey = 'public_homepage_products';
    const cached = localCache.get(cacheKey);
    if (cached) return cached;

    const fields = `id, sku, brand, model_name as name, series, scale, casing, tag, subtags,
      COALESCE(selling_price, base_price, 0.00) as price,
      COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
      (COALESCE(available_stock, stock, total_stock, 0) <= 0) as "isSoldOut",
      is_prebook as "isPrebook", COALESCE(customer_eta, arrival_date) as "customerEta",
      COALESCE(image, (SELECT thumbnail_url FROM product_images WHERE product_id = products.id ORDER BY is_primary DESC, created_at ASC LIMIT 1)) as image,
      created_at`;
    const settings = await this.getGlobalSettings();
    const stockVisibility = settings.showSoldOutProducts === false
      ? ` AND COALESCE(available_stock, stock, total_stock, 0) > 0`
      : '';
    const visibility = `deleted_at IS NULL AND (status IN ('Published', 'Pre-Order', 'Active') OR status IS NULL)${stockVisibility}`;

    const [featured, recent] = await Promise.all([
      this.dataSource.query(`SELECT ${fields} FROM products WHERE ${visibility} AND is_featured = true ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1;`),
      this.dataSource.query(`SELECT ${fields} FROM products WHERE ${visibility} ORDER BY created_at DESC LIMIT 8;`)
    ]);
    const payload = { featured: featured[0] || null, recent };
    localCache.set(cacheKey, payload, 30);
    return payload;
  }

  async setUserRole(email: string, role: string, performedBy: string, ipAddress: string) {
    const emailClean = String(email || '').trim().toLowerCase();
    const allowedRoles = new Set(['Admin', 'Collector', 'Warehouse']);
    if (!/^\S+@\S+\.\S+$/.test(emailClean)) throw new BadRequestException('Enter a valid email address.');
    if (!allowedRoles.has(role)) throw new BadRequestException('Role must be Admin, Collector, or Warehouse.');

    const beforeRows = await this.dataSource.query(
      'SELECT id, email, role FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1;',
      [emailClean]
    );
    const result = await this.dataSource.query(`
      INSERT INTO users (email, role)
      VALUES ($1, $2)
      ON CONFLICT (email) DO UPDATE
      SET role = EXCLUDED.role, updated_at = NOW(), deleted_at = NULL
      RETURNING id, email, role;
    `, [emailClean, role]);
    await this.writeAuditLog('USER_ROLE_CHANGED', 'users', result[0].id, performedBy, ipAddress, beforeRows[0] || null, result[0]);
    return result[0];
  }

  async getPaginatedProducts(options: {
    page?: number;
    limit?: number;
    offset?: number;
    brand?: string;
    scale?: string;
    tag?: string;
    search?: string;
    inStock?: boolean;
    preBooking?: boolean;
    adminMode?: boolean;
    userAgent?: string;
  }) {
    const settingsCacheKey = 'public_product_page_settings';
    let settings = localCache.get(settingsCacheKey);
    if (!settings) {
      const rowsSettings = await this.dataSource.query("SELECT value FROM global_settings WHERE key = 'app_settings';");
      settings = rowsSettings.length > 0 ? rowsSettings[0].value : {};
      localCache.set(settingsCacheKey, settings, 60);
    }
    const isMobile = options.userAgent ? /mobi|android|iphone|ipad|phone/i.test(options.userAgent) : false;
    const defaultPageSize = isMobile 
      ? (settings.marketplaceMobileInitialPageSize || 5) 
      : (settings.marketplaceDesktopInitialPageSize || 12);

    const maxLimit = options.adminMode ? 100 : 50;
    const limit = Math.max(1, Math.min(maxLimit, Number(options.limit || defaultPageSize)));
    const page = Math.max(1, Number(options.page || 1));
    const offset = options.offset !== undefined ? Number(options.offset) : (page - 1) * limit;

    const selectFields = options.adminMode
      ? `id, sku, brand, model_name as name, series, scale, casing, tag, subtags, status,
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         COALESCE(stock, total_stock, 0)::int as "availableStock",
         is_prebook as "isPrebook",
         COALESCE(customer_eta, arrival_date) as "customerEta",
         COALESCE(image, (SELECT thumbnail_url FROM product_images WHERE product_id = products.id LIMIT 1)) as image,
         created_at`
      : `id, sku, brand, model_name as name, series, scale, casing, tag, subtags,
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         (COALESCE(available_stock, stock, total_stock, 0) <= 0) as "isSoldOut",
         is_prebook as "isPrebook",
         COALESCE(customer_eta, arrival_date) as "customerEta",
         COALESCE(image, (SELECT thumbnail_url FROM product_images WHERE product_id = products.id LIMIT 1)) as image,
         created_at`;

    let queryStr = `
      SELECT ${selectFields}
      FROM products
      WHERE deleted_at IS NULL
    `;

    if (!options.adminMode) {
      queryStr += ` AND (status IN ('Published', 'Pre-Order', 'Active') OR status IS NULL)`;
      if (settings.showSoldOutProducts === false) {
        queryStr += ` AND COALESCE(available_stock, stock, total_stock, 0) > 0`;
      }
    }

    const params: any[] = [];
    let paramIndex = 1;

    if (options.brand) {
      queryStr += ` AND LOWER(brand) = LOWER($${paramIndex})`;
      params.push(options.brand);
      paramIndex++;
    }

    if (options.scale) {
      queryStr += ` AND scale = $${paramIndex}`;
      params.push(options.scale);
      paramIndex++;
    }

    if (options.tag) {
      queryStr += ` AND $${paramIndex} = ANY(subtags)`;
      params.push(options.tag);
      paramIndex++;
    }

    if (options.inStock) {
      queryStr += ` AND COALESCE(available_stock, stock, total_stock, 0) > 0
                    AND COALESCE(is_prebook, false) = false
                    AND COALESCE(status, '') != 'Pre-Order'`;
    }

    if (options.preBooking) {
      queryStr += ` AND (is_prebook = true OR status = 'Pre-Order')`;
    }

    if (options.search) {
      queryStr += ` AND (
        LOWER(model_name) LIKE LOWER($${paramIndex}) OR
        LOWER(brand) LIKE LOWER($${paramIndex}) OR
        LOWER(series) LIKE LOWER($${paramIndex}) OR
        LOWER(sku) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    // Clone query for count
    const countQuery = `SELECT COUNT(*)::int as total FROM (${queryStr}) as sub`;
    const dataQuery = `${queryStr} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    const dataParams = [...params, limit, offset];
    const [countRows, rows] = await Promise.all([
      this.dataSource.query(countQuery, params),
      this.dataSource.query(dataQuery, dataParams)
    ]);
    const total = parseInt(countRows[0]?.total || '0', 10);

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
             p.rarity_level as lane, p.rarity_level as grade, p.rarity_level as manufacturer, p.base_price as price, p.description,
             p.tags, p.category, p.selling_price as "sellingPrice",
             ${adminFields}
             COALESCE(
               p.available_stock,
               p.stock,
               p.total_stock - COALESCE(p.locked_stock, 0) - COALESCE(p.sold_stock, 0),
               p.total_stock,
               0
             )::int as "availableStock",
             p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage", p.is_featured as "isFeatured",
             p.casing, p.casing_types as "casingTypes",
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

    if (!adminMode) {
      const settings = await this.getGlobalSettings();
      const soldOut = Number(product.availableStock || 0) <= 0;
      if (settings.showSoldOutProducts === false && soldOut) return null;
    }

    const casings = await this.dataSource.query(`
      SELECT ct.name as "casingType", 
             MAX(pv.selling_price)::float as "price",
             SUM(ib.quantity_available)::int as "availableStock"
      FROM inventory_batches ib
      JOIN product_variants pv ON ib.variant_id = pv.id
      JOIN casing_types ct ON pv.casing_type_id = ct.id
      WHERE pv.product_id = $1 AND ib.status = 'Open' AND ib.quantity_available > 0
      GROUP BY ct.name
      ORDER BY price ASC;
    `, [id]);

    product.availableCasings = casings;

    const variants = await this.dataSource.query(`
      SELECT pv.id, p.sku, pv.barcode, pv.name, pv.selling_price as "sellingPrice",
             pv.customer_eta as "customerEta", pv.visibility, pv.status, pv.sales_status as "salesStatus",
             pv.dimensions, pv.weight, pv.variant_attributes as "variantAttributes",
             pv.total_stock as "totalStock", pv.sold_stock as "soldStock", pv.locked_stock as "lockedStock",
             GREATEST(0, (pv.total_stock - pv.locked_stock - pv.sold_stock)) as "availableStock",
             ct.name as casing, ct.display_name as "casingDisplay"
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      JOIN casing_types ct ON ct.id = pv.casing_type_id
      WHERE pv.product_id = $1 AND pv.deleted_at IS NULL
    `, [id]);
    product.variants = variants;

    const images = await this.dataSource.query(`
      SELECT id, product_id as "productId", thumbnail_url as "thumbnailUrl", full_url as "fullUrl", is_primary as "isPrimary"
      FROM product_images
      WHERE product_id = $1
      ORDER BY is_primary DESC, id ASC;
    `, [id]);
    product.images = images.map(img => img.fullUrl || img.thumbnailUrl).filter(Boolean);
    if (product.images.length > 0 && !product.image) {
      product.image = product.images[0];
    }
    product.images = images;

    localCache.set(cacheKey, product, 10); // Cache single item for 10 seconds
    return product;
  }

  async addProduct(car: any, creatorEmail: string, ipAddress: string) {
    const sku = String(car.sku || `SKU-${Date.now()}`).trim().toUpperCase();
    const brandName = String(car.brand || 'Mini GT').trim();
    await this.validateCatalogReferences(car);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const imageList = Array.isArray(car.images) && car.images.length > 0
        ? car.images.filter(Boolean)
        : (car.image ? [car.image] : []);

      const primaryImg = car.image || imageList[0] || null;
      const initialStock = Number(car.stock !== undefined ? car.stock : (car.availableStock !== undefined ? car.availableStock : (car.totalStock !== undefined ? car.totalStock : 0)));
      const poDeposit = Number(car.poAmount !== undefined ? car.poAmount : (car.prebookDepositAmount || 0));
      const priceVal = Number(car.price || car.sellingPrice || 0);

      const rawCasing = car.casing || car.casingType || 'Blister';
      const reqCasing = rawCasing.charAt(0).toUpperCase() + rawCasing.slice(1).toLowerCase();
      const isFeaturedVal = car.isFeatured !== undefined ? Boolean(car.isFeatured) : Boolean(car.showOnHomepage);

      if (isFeaturedVal) {
        await queryRunner.query("UPDATE products SET is_featured = FALSE WHERE is_featured = TRUE AND deleted_at IS NULL;");
      }

      const prodRes = await queryRunner.query(`
        INSERT INTO products (
          sku, brand, model_name, series, scale, casing, casing_types, base_price, selling_price, price,
          po_amount, prebook_deposit_amount, stock, total_stock, available_stock, is_prebook, is_featured, status,
          customer_eta, arrival_date, release_date, tag, subtags, tags, description, image, images,
          supplier, created_by, category
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
        RETURNING id;
      `, [
        sku,
        brandName,
        car.name || 'Unknown Casting',
        car.series || 'Collector Series',
        car.scale || '1:64',
        reqCasing,
        [reqCasing.toLowerCase()],
        priceVal,
        priceVal,
        priceVal,
        poDeposit,
        poDeposit,
        initialStock,
        initialStock,
        initialStock,
        Boolean(car.isPrebook),
        isFeaturedVal,
        car.status || (car.isPrebook ? 'Pre-Order' : 'Published'),
        car.customerEta || car.arrivalDate || car.releaseDate || null,
        car.arrivalDate || car.customerEta || null,
        car.releaseDate || car.customerEta || null,
        car.tag || car.grade || car.lane || null,
        car.subtags || car.tags || [],
        car.tags || car.subtags || [],
        car.description || '',
        primaryImg,
        imageList,
        car.supplier || '',
        creatorEmail,
        car.category || 'JDM'
      ]);
      const productId = prodRes[0].id;

      for (let idx = 0; idx < imageList.length; idx++) {
        const imgUrl = imageList[idx];
        const isPrimary = idx === 0;
        await queryRunner.query(`
          INSERT INTO product_images (product_id, url, thumbnail_url, medium_url, full_url, is_primary)
          VALUES ($1, $2, $3, $4, $5, $6);
        `, [productId, imgUrl, imgUrl, imgUrl, imgUrl, isPrimary]);
      }

      await queryRunner.query(`
        INSERT INTO inventory (product_id, quantity_available, quantity_reserved, quantity_sold, quantity_returned, quantity_damaged, quantity_locked)
        VALUES ($1, 0, 0, 0, 0, 0, 0)
        ON CONFLICT (product_id) DO NOTHING;
      `, [productId]);

      // Resolve casing type mapping
      const casingTypesRes = await queryRunner.query("SELECT id, name FROM casing_types;");
      const casingMap = {};
      for (const ct of casingTypesRes) {
        casingMap[ct.name.toUpperCase()] = ct.id;
      }

      if (car.variants && car.variants.length > 0) {
        for (const v of car.variants) {
          const casingTypeId = casingMap[v.casing.toUpperCase()] || casingTypesRes[0]?.id;
          if (!casingTypeId) {
            throw new Error(`Casing type "${v.casing}" not registered in database.`);
          }
          
          await queryRunner.query(`
            INSERT INTO product_variants (
              product_id, casing_type_id, sku, barcode, name, selling_price, customer_eta, 
              visibility, status, sales_status, dimensions, weight, variant_attributes, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);
          `, [
            productId,
            casingTypeId,
            sku,
            v.barcode || null,
            v.name || `${car.name || 'Unknown Casting'} (${v.casing})`,
            Number(v.price || 0),
            v.customerEta || null,
            v.isVisible !== false ? 'Visible' : 'Hidden',
            v.status || 'Active',
            v.salesStatus || 'Available',
            v.dimensions || null,
            v.weight ? Number(v.weight) : null,
            v.variantAttributes ? JSON.stringify(v.variantAttributes) : '{}',
            creatorEmail
          ]);
        }
      } else {
        // Fallback default variant matching requested casing
        let casingTypeId = casingMap[reqCasing.toUpperCase()];
        if (!casingTypeId) {
          const insRes = await queryRunner.query(`
            INSERT INTO casing_types (name, display_name)
            VALUES ($1, $2)
            ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
            RETURNING id;
          `, [reqCasing.toUpperCase(), reqCasing]);
          casingTypeId = insRes[0]?.id;
        }

        await queryRunner.query(`
          INSERT INTO product_variants (
            product_id, casing_type_id, sku, name, selling_price, visibility, status, sales_status, created_by
          )
          VALUES ($1, $2, $3, $4, $5, 'Visible', 'Active', 'Available', $6);
        `, [
          productId,
          casingTypeId,
          sku,
          `${car.name || 'Unknown Casting'} (${reqCasing})`,
          Number(car.price || 0),
          creatorEmail
        ]);
      }

      const targetVariantRes = await queryRunner.query("SELECT id FROM product_variants WHERE product_id = $1 ORDER BY created_at ASC LIMIT 1;", [productId]);
      const targetVariantId = targetVariantRes[0]?.id;

      const batchStock = Number(car.totalStock || car.availableStock || 0);
      if (batchStock > 0 && targetVariantId) {
        await this.receiveInventoryBatchTx(
          queryRunner,
          targetVariantId,
          car.supplier || 'Default Supplier',
          Number(car.purchasePrice || 0),
          Number(car.price || 0),
          batchStock,
          creatorEmail,
          ipAddress
        );
      }

      // Low stock check trigger
      if (initialStock <= 3) {
        await this.createSystemNotification(
          'Low Stock Alert',
          `Casting "${car.name}" has critical stock count: ${initialStock}`,
          'low_stock',
          null,
          queryRunner
        );
      }

      await this.writeAuditLog('CREATE_PRODUCT', 'products', productId, creatorEmail, ipAddress, null, car, queryRunner);
      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      return { id: productId, sku };
    } catch (err: any) {
      await queryRunner.rollbackTransaction();

      const dbCode = err?.code || err?.driverError?.code;
      const constraint = err?.constraint || err?.driverError?.constraint;
      if (dbCode === '23505') {
        if (constraint === 'products_sku_key' || constraint === 'idx_products_sku_active_normalized') {
          throw new ConflictException(`A product with SKU "${sku}" already exists. Open that product to update it, or use a different SKU.`);
        }
        throw new ConflictException('A product with the same unique details already exists.');
      }
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async updateProduct(id: string, car: any, updaterEmail: string, ipAddress: string) {
    await this.validateCatalogReferences(car);
    const oldRes = await this.dataSource.query("SELECT * FROM products WHERE id = $1", [id]);
    const oldData = oldRes[0];

    if (oldData && car.version !== undefined && car.version !== null && Number(oldData.version) !== Number(car.version)) {
      throw new BadRequestException("This product has been modified by another administrator. Please refresh and try again.");
    }

    const queryRunner = this.dataSource.createQueryRunner();
    const v0 = Array.isArray(car.variants) && car.variants[0];
    const hasExplicitStockUpdate = car.totalStock !== undefined || car.stock !== undefined || car.availableStock !== undefined || v0?.totalStock !== undefined || v0?.stock !== undefined || v0?.availableStock !== undefined;
    const requestedAvailableStock = hasExplicitStockUpdate
      ? Math.max(0, Number(
          car.totalStock !== undefined 
            ? car.totalStock 
            : (car.stock !== undefined 
                ? car.stock 
                : (car.availableStock !== undefined 
                    ? car.availableStock 
                    : (v0?.totalStock !== undefined 
                        ? v0.totalStock 
                        : (v0?.stock !== undefined 
                            ? v0.stock 
                            : (v0?.availableStock !== undefined ? v0.availableStock : 0)))))
        ))
      : null;
    let stockReconciliationVariantId: string | null = null;
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const hasImagesUpdate = Object.prototype.hasOwnProperty.call(car, 'images') && Array.isArray(car.images);
      const hasPrimaryImageUpdate = Object.prototype.hasOwnProperty.call(car, 'image');
      const imageList = hasImagesUpdate
        ? car.images.filter(Boolean)
        : (hasPrimaryImageUpdate
          ? (car.image ? [car.image] : [])
          : (Array.isArray(oldData.images) ? oldData.images.filter(Boolean) : []));

      // Empty image fields are an explicit request to clear the product gallery.
      // Only omitted image fields preserve the existing primary image.
      const primaryImg = hasPrimaryImageUpdate
        ? (car.image || imageList[0] || null)
        : (hasImagesUpdate ? (imageList[0] || null) : (oldData.image || imageList[0] || null));
      const finalStock = Number(
        car.totalStock !== undefined 
          ? car.totalStock 
          : (car.stock !== undefined 
              ? car.stock 
              : (car.availableStock !== undefined 
                  ? car.availableStock 
                  : (v0?.totalStock !== undefined 
                      ? v0.totalStock 
                      : (v0?.stock !== undefined 
                          ? v0.stock 
                          : (v0?.availableStock !== undefined ? v0.availableStock : (oldData.stock || 0))))))
      );
      const poDeposit = Number(car.poAmount !== undefined ? car.poAmount : (car.prebookDepositAmount !== undefined ? car.prebookDepositAmount : (oldData.po_amount || 0)));
      const priceVal = Number(car.price !== undefined ? car.price : (car.sellingPrice !== undefined ? car.sellingPrice : (oldData.price || 0)));

      const rawCasing = car.casing || car.casingType || oldData.casing || 'Blister';
      const reqCasing = rawCasing.charAt(0).toUpperCase() + rawCasing.slice(1).toLowerCase();
      const isFeaturedVal = car.isFeatured !== undefined ? Boolean(car.isFeatured) : (car.showOnHomepage !== undefined ? Boolean(car.showOnHomepage) : oldData.is_featured);

      if (isFeaturedVal && !oldData.is_featured) {
        await queryRunner.query("UPDATE products SET is_featured = FALSE WHERE is_featured = TRUE AND id != $1 AND deleted_at IS NULL;", [id]);
      }

      await queryRunner.query(`
        UPDATE products 
        SET sku = $1, brand = $2, model_name = $3, series = $4, scale = $5, casing = $6, casing_types = $7,
            base_price = $8, selling_price = $9, price = $10, po_amount = $11, prebook_deposit_amount = $12,
            stock = $13, total_stock = $14, available_stock = $14,
            is_prebook = $15, is_featured = $16, status = $17, customer_eta = $18,
            arrival_date = $19, release_date = $20, tag = $21, subtags = $22, tags = $23,
            description = $24, image = $25, images = $26, supplier = $27, updated_by = $28, updated_at = NOW()
        WHERE id = $29;
      `, [
        car.sku || oldData.sku,
        car.brand || oldData.brand,
        car.name || oldData.model_name,
        car.series !== undefined ? car.series : oldData.series,
        car.scale || oldData.scale,
        reqCasing,
        [reqCasing.toLowerCase()],
        priceVal,
        priceVal,
        priceVal,
        poDeposit,
        poDeposit,
        finalStock,
        finalStock,
        car.isPrebook !== undefined ? Boolean(car.isPrebook) : oldData.is_prebook,
        isFeaturedVal,
        car.status || oldData.status,
        car.customerEta !== undefined ? car.customerEta : (car.arrivalDate !== undefined ? car.arrivalDate : oldData.customer_eta),
        car.arrivalDate !== undefined ? car.arrivalDate : oldData.arrival_date,
        car.releaseDate !== undefined ? car.releaseDate : oldData.release_date,
        car.tag || car.grade || car.lane || oldData.tag,
        car.subtags || car.tags || oldData.subtags || [],
        car.tags || car.subtags || oldData.tags || [],
        car.description !== undefined ? car.description : oldData.description,
        primaryImg,
        imageList,
        car.supplier || oldData.supplier,
        updaterEmail,
        id
      ]);

      // Sync product_images table
      if (hasImagesUpdate || hasPrimaryImageUpdate) {
        await queryRunner.query("DELETE FROM product_images WHERE product_id = $1;", [id]);
        for (let idx = 0; idx < imageList.length; idx++) {
          const imgUrl = imageList[idx];
          const isPrimary = idx === 0;
          await queryRunner.query(`
            INSERT INTO product_images (product_id, url, thumbnail_url, medium_url, full_url, is_primary)
            VALUES ($1, $2, $3, $4, $5, $6);
          `, [id, imgUrl, imgUrl, imgUrl, imgUrl, isPrimary]);
        }
      }

      // Update variants if car.variants is provided, or fallback to updating primary variant
      const casingTypesRes = await queryRunner.query("SELECT id, name FROM casing_types;");
      const casingMap: Record<string, string> = {};
      for (const ct of casingTypesRes) {
        casingMap[ct.name.toUpperCase()] = ct.id;
      }

      const getOrInsertCasingTypeId = async (casingName: string) => {
        const upper = casingName.toUpperCase();
        if (casingMap[upper]) return casingMap[upper];
        const insRes = await queryRunner.query(`
          INSERT INTO casing_types (name, display_name)
          VALUES ($1, $2)
          ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
          RETURNING id;
        `, [upper, casingName]);
        const newId = insRes[0]?.id;
        casingMap[upper] = newId;
        return newId;
      };

      if (Array.isArray(car.variants) && car.variants.length > 0) {
        for (const v of car.variants) {
          const vCasing = v.casing || 'Blister';
          const casingTypeId = await getOrInsertCasingTypeId(vCasing);
          const vSku = String(car.sku || oldData.sku).trim().toUpperCase();
          const vName = v.name || `${car.name || oldData.model_name || 'Unknown Casting'} (${vCasing})`;
          const vPrice = Number(v.price || v.sellingPrice || priceVal);

          const existingVar = await queryRunner.query(
            "SELECT id FROM product_variants WHERE product_id = $1 AND casing_type_id = $2 AND deleted_at IS NULL;",
            [id, casingTypeId]
          );

          if (existingVar.length > 0) {
            await queryRunner.query(`
              UPDATE product_variants 
              SET selling_price = $1, name = $2, sku = $3, total_stock = $5, updated_at = NOW()
              WHERE id = $4;
            `, [vPrice, vName, vSku, existingVar[0].id, finalStock]);
          } else {
            await queryRunner.query(`
              INSERT INTO product_variants (
                product_id, casing_type_id, sku, name, selling_price, total_stock, visibility, status, sales_status, created_by
              )
              VALUES ($1, $2, $3, $4, $5, $6, 'Visible', 'Active', 'Available', $7);
            `, [id, casingTypeId, vSku, vName, vPrice, finalStock, updaterEmail]);
          }
        }
      } else {
        const casingTypeId = await getOrInsertCasingTypeId(reqCasing);
        if (casingTypeId) {
          await queryRunner.query(`
            UPDATE product_variants 
            SET casing_type_id = $1, 
                name = $2,
                selling_price = $3,
                total_stock = $5,
                updated_at = NOW()
            WHERE id = (
              SELECT id FROM product_variants WHERE product_id = $4 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1
            );
          `, [casingTypeId, `${car.name || oldData.model_name || 'Unknown Casting'} (${reqCasing})`, priceVal, id, finalStock]);
        }
      }

      if (hasExplicitStockUpdate) {
        const primaryVariant = await queryRunner.query(`
          SELECT id
          FROM product_variants
          WHERE product_id = $1 AND deleted_at IS NULL
          ORDER BY created_at ASC
          LIMIT 1;
        `, [id]);
        stockReconciliationVariantId = primaryVariant[0]?.id || null;
      }

      await this.writeAuditLog('UPDATE_PRODUCT', 'products', id, updaterEmail, ipAddress, oldData, car, queryRunner);
      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');
      localCache.del(`product_${id}_true`);
      localCache.del(`product_${id}_false`);
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    } finally {
      await queryRunner.release();
    }

    if (stockReconciliationVariantId && requestedAvailableStock !== null) {
      await this.reconcileVariantInventory(
        stockReconciliationVariantId,
        requestedAvailableStock,
        'Stock quantity updated from product catalogue',
        updaterEmail,
        ipAddress
      );
    }

    return this.getProduct(id, true);
  }

  async softDeleteProduct(id: string, deleterEmail: string, ipAddress: string) {
    const oldRes = await this.dataSource.query("SELECT * FROM products WHERE id = $1", [id]);
    await this.dataSource.query("UPDATE products SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1;", [id]);
    localCache.del('products_list_true');
    localCache.del('products_list_false');
    await this.writeAuditLog('DELETE_PRODUCT', 'products', id, deleterEmail, ipAddress, oldRes[0], { deleted: true });
    return { success: true };
  }

async calculateCheckoutPricing(dto: any) {
    const items = dto.items || [];
    const bookingType = dto.bookingType || 'standard';
    const isPreOrder = bookingType === 'pre_order';

    const resolvedItems = [];
    let subtotal = 0;

    for (const item of items) {
      const id = item.productId || item.variantId;
      if (!id) continue;
      const qty = Math.max(1, parseInt(item.qty || item.quantity || '1', 10));

      const rows = await this.dataSource.query(`
        SELECT pv.id as "variantId", 
               pv.selling_price as "sellingPrice", 
               p.sku,
               pv.name as "variantName", 
               pv.version as "version",
               p.id as "productId",
               p.model_name as "productName",
               p.brand, 
               p.rarity_level as "manufacturer", 
               ct.name as "casing",
               p.prebook_deposit_amount as "prebookDepositAmount",
               p.is_prebook as "isPrebook"
        FROM product_variants pv 
        JOIN products p ON p.id = pv.product_id 
        JOIN casing_types ct ON ct.id = pv.casing_type_id 
        WHERE (pv.id = $1 OR pv.product_id = $1) AND pv.deleted_at IS NULL 
        ORDER BY pv.created_at ASC 
        LIMIT 1;
      `, [id]);

      if (rows.length > 0) {
        const row = rows[0];
        const itemPrice = Number(row.sellingPrice || 0);
        subtotal += itemPrice * qty;
        resolvedItems.push({
          productId: row.productId,
          variantId: row.variantId,
          name: row.productName,
          variantName: row.variantName,
          sku: row.sku,
          brand: row.brand,
          casing: row.casing,
          manufacturer: row.manufacturer,
          price: itemPrice,
          prebookDepositAmount: row.prebookDepositAmount,
          isPrebook: row.isPrebook === true || row.isPrebook === 1,
          version: Number(row.version || 1),
          qty
        });
      }
    }

    const settings = await this.getGlobalSettings();
    const defaultShippingFee = settings.shippingConfig?.defaultFee || 200;

    const groups = [];
    const standardItems = resolvedItems.filter(item => !item.isPrebook);
    const prebookItems = resolvedItems.filter(item => item.isPrebook);

    // 1. Standard items group (all standard items in one order)
    if (standardItems.length > 0) {
      const gSubtotal = standardItems.reduce((sum, item) => sum + item.price * item.qty, 0);
      const gShipping = defaultShippingFee;
      const gTotal = gSubtotal + gShipping;
      groups.push({
        bookingType: 'standard',
        items: standardItems,
        subtotal: gSubtotal,
        shippingFee: gShipping,
        totalPrice: gTotal,
        advanceAmount: gTotal,
        remainingAmount: 0
      });
    }

    // 2. Pre-order groups (each pre-booking item gets its own separate order)
    for (const item of prebookItems) {
      const gSubtotal = item.price * item.qty;
      const gShipping = 0; // ₹0 shipping at checkout for pre-order
      const gTotal = gSubtotal + gShipping;
      groups.push({
        bookingType: 'pre_order',
        items: [item],
        subtotal: gSubtotal,
        shippingFee: gShipping,
        totalPrice: gTotal,
        advanceAmount: gTotal, // 100% upfront pay since toggle is removed
        remainingAmount: 0
      });
    }

    const grandSubtotal = groups.reduce((sum, g) => sum + g.subtotal, 0);
    const grandShipping = groups.reduce((sum, g) => sum + g.shippingFee, 0);
    const grandTotal = groups.reduce((sum, g) => sum + g.totalPrice, 0);
    const grandAdvance = groups.reduce((sum, g) => sum + g.advanceAmount, 0);
    const grandRemaining = groups.reduce((sum, g) => sum + g.remainingAmount, 0);

    return {
      subtotal: grandSubtotal,
      shippingFee: grandShipping,
      totalPrice: grandTotal,
      advanceAmount: grandAdvance,
      remainingAmount: grandRemaining,
      items: resolvedItems,
      inventoryVersions: resolvedItems.map(item => ({ id: item.variantId, version: item.version })),
      groups
    };
  }

  async restoreProduct(id: string, updaterEmail: string, ipAddress: string) {
    await this.dataSource.query("UPDATE products SET deleted_at = NULL, updated_at = NOW() WHERE id = $1;", [id]);
    localCache.del('products_list_true');
    localCache.del('products_list_false');
    await this.writeAuditLog('RESTORE_PRODUCT', 'products', id, updaterEmail, ipAddress, { deleted: true }, { restored: true });
    return { success: true };
  }

  // ── IDEMPOTENCY LOCK SERVICE METHODS ────────────────────────────────
  async checkIdempotency(key: string, userId: string): Promise<any | null> {
    if (!key) return null;
    const rows = await this.dataSource.query(
      "SELECT resource_type, resource_id FROM idempotency_keys WHERE key = $1 AND user_id = $2 LIMIT 1;",
      [key, userId]
    );
    if (rows.length === 0) return null;

    const { resource_type, resource_id } = rows[0];
    if (resource_type === 'Order') {
      const orderRows = await this.dataSource.query(
        'SELECT id, booking_type as "bookingType", advance_amount as "advanceAmount", remaining_amount as "remainingAmount" FROM orders WHERE id = $1',
        [resource_id]
      );
      if (orderRows.length > 0) {
        return {
          success: true,
          orderId: orderRows[0].id,
          bookingType: orderRows[0].bookingType,
          advanceAmount: Number(orderRows[0].advanceAmount),
          remainingAmount: Number(orderRows[0].remainingAmount),
          idempotentCached: true
        };
      }
    }
    return null;
  }

  async saveIdempotency(key: string, userId: string, endpoint: string, resourceType: string, resourceId: string, queryRunner: any) {
    if (!key) return;
    await queryRunner.query(`
      INSERT INTO idempotency_keys (key, user_id, endpoint, resource_type, resource_id, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours')
      ON CONFLICT (key) DO NOTHING;
    `, [key, userId, endpoint, resourceType, resourceId]);
  }

  // ── ATOMIC TRANSACTIONAL STOCK LOCKING (RESERVATIONS - DIRECT ORDER TRANSITION) ──
  async reserveProduct(dto: any, ipAddress: string, authenticatedUserId: string) {
    this.triggerLazyCleanup();

    const { productId, name, instagram, phone, address, idempotencyKey, bookingType, advanceAmount } = dto;
    const requestedQty = Math.max(1, Math.min(10, parseInt(dto.qty || dto.quantity || '1', 10)));
    const isPreOrder = bookingType === 'pre_order';

    if (!authenticatedUserId) {
      throw new UnauthorizedException("Authentication is required to perform checkout.");
    }

    // A. Resolve User details safely (No JWT Spoofing)
    const userRows = await this.dataSource.query("SELECT email FROM users WHERE id = $1", [authenticatedUserId]);
    if (userRows.length === 0) {
      throw new UnauthorizedException("Authenticated session user not found.");
    }
    const email = userRows[0].email;

    // B. Stateless DB Rate Limiting: max 3 requests per 10 seconds per user
    const rateCheck = await this.dataSource.query(`
      SELECT COUNT(*) as count FROM orders 
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '10 seconds';
    `, [authenticatedUserId]);
    if (Number(rateCheck[0].count) >= 3) {
      throw new HttpException({
        statusCode: 429,
        message: "Too many checkout attempts. Please wait a few seconds and try again."
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    // C. Check Idempotency Key
    const cacheRes = await this.checkIdempotency(idempotencyKey, authenticatedUserId);
    if (cacheRes) return cacheRes;

    // D. Perform Backend Price & Shipping calculations
    const pricing = await this.calculateCheckoutPricing({
      items: [{ productId, qty: requestedQty }],
      bookingType,
      advanceAmount
    });

    if (pricing.items.length === 0) {
      throw new BadRequestException("Target casting does not exist or has been archived.");
    }

    const resolvedItem = pricing.items[0];
    const unitPrice = resolvedItem.price;
    const fullPrice = pricing.totalPrice;
    const advPaid = pricing.advanceAmount;
    const remaining = pricing.remainingAmount;
    const shippingCost = pricing.shippingFee;
    const variantId = resolvedItem.variantId;

    // Process Version locks
    const clientVersions = dto.inventoryVersions || [];
    const clientVersionMap = new Map(clientVersions.map((cv: any) => [cv.id, Number(cv.version)]));

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // E. Row-level lock variant and batches (FOR UPDATE)
      const varRows = await queryRunner.query(`
        SELECT id, product_id, total_stock, locked_stock, sold_stock, version 
        FROM product_variants 
        WHERE id = $1 AND deleted_at IS NULL 
        FOR UPDATE;
      `, [variantId]);

      if (varRows.length === 0) {
        throw new BadRequestException("Target casting variant does not exist or has been archived.");
      }

      const pv = varRows[0];
      const available = Number(pv.total_stock) - Number(pv.locked_stock || 0) - Number(pv.sold_stock);

      if (available <= 0) {
        throw new BadRequestException(`Casting "${resolvedItem.name}" is sold out.`);
      }

      if (requestedQty > available) {
        throw new BadRequestException(`Only ${available} unit(s) of "${resolvedItem.name}" are available. You requested ${requestedQty}.`);
      }

      // F. Version comparison check
      const clientVersion = clientVersionMap.get(variantId);
      if (clientVersion !== undefined && Number(pv.version) !== Number(clientVersion)) {
        throw new BadRequestException("Inventory changed while you were checking out. Please review your order.");
      }

      // Lock matching batches row-level
      await queryRunner.query(`
        SELECT id FROM inventory_batches 
        WHERE variant_id = $1 
        FOR UPDATE;
      `, [variantId]);

      // Check customer purchase limit
      const prodRows = await queryRunner.query("SELECT max_qty_per_customer FROM products WHERE id = $1 FOR UPDATE;", [productId]);
      const p = prodRows[0];
      if (p && p.max_qty_per_customer !== null && p.max_qty_per_customer > 0) {
        const existingCountRes = await queryRunner.query(`
          SELECT COALESCE(SUM(oi.qty), 0) as total
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE oi.product_id = $1 
            AND o.user_id = $2 
            AND o.status NOT IN ('Cancelled', 'Expired');
        `, [productId, authenticatedUserId]);
        const existingCount = Number(existingCountRes[0].total);
        if (existingCount + requestedQty > p.max_qty_per_customer) {
          throw new BadRequestException(`Purchase limit exceeded. You have already ordered/reserved ${existingCount} items. Max limit: ${p.max_qty_per_customer}.`);
        }
      }

      // G. Get/create customer record
      const custRes = await queryRunner.query(`
        INSERT INTO customers (full_name, phone, instagram, address, email, city)
        VALUES ($1, $2, $3, $4, $5, 'Unknown')
        ON CONFLICT (email) DO UPDATE 
        SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, instagram = EXCLUDED.instagram, address = EXCLUDED.address
        RETURNING id;
      `, [name, phone, instagram, address, email.trim().toLowerCase()]);
      const customerId = custRes[0].id;

      // H. Create parent Pending order record
      const actualBookingType = (bookingType === 'pre_order' || resolvedItem.isPrebook) ? 'pre_order' : 'standard';
      const orderStatus = (actualBookingType === 'pre_order') ? 'Pre-Order' : 'Pending';

      const orderRes = await queryRunner.query(`
        INSERT INTO orders (user_id, total_price, shipping_address, status, booking_type, advance_amount, remaining_amount, shipping_cost, created_at, updated_at, idempotency_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9)
        RETURNING id;
      `, [authenticatedUserId, fullPrice, `${address} | Insta: ${instagram} | Phone: ${phone}`, orderStatus, actualBookingType, advPaid, remaining, shippingCost, idempotencyKey]);
      const orderId = orderRes[0].id;

      // I. Create Order Event record
      await queryRunner.query(`
        INSERT INTO order_events (order_id, event_type, previous_status, new_status, details, performed_by)
        VALUES ($1, 'ORDER_CREATED', NULL, $2, 'Order created by customer checkout', $3);
      `, [orderId, orderStatus, email]);

      // J. Create order item with snapshots
      await queryRunner.query(`
        INSERT INTO order_items (order_id, variant_id, product_id, qty, price_at_purchase, variant_name_snapshot, sku_snapshot, brand_snapshot, casing_snapshot, manufacturer_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `, [orderId, variantId, productId, requestedQty, unitPrice, resolvedItem.variantName, resolvedItem.sku, resolvedItem.brand, resolvedItem.casing, resolvedItem.manufacturer]);

      // K. Lock stock (increment variant locked_stock and increment variant version)
      await queryRunner.query(`
        UPDATE product_variants 
        SET locked_stock = COALESCE(locked_stock, 0) + $1,
            updated_at = NOW() 
        WHERE id = $2;
      `, [requestedQty, variantId]);

      // L. Sync parent products aggregate cache
      await queryRunner.query(`
        UPDATE products p
        SET total_stock = (SELECT COALESCE(SUM(total_stock), 0) FROM product_variants WHERE product_id = p.id AND deleted_at IS NULL),
            locked_stock = (SELECT COALESCE(SUM(locked_stock), 0) FROM product_variants WHERE product_id = p.id AND deleted_at IS NULL),
            sold_stock = (SELECT COALESCE(SUM(sold_stock), 0) FROM product_variants WHERE product_id = p.id AND deleted_at IS NULL),
            updated_at = NOW()
        WHERE p.id = $1;
      `, [productId]);

      // M. Record in inventory ledger
      await queryRunner.query(`
        INSERT INTO inventory_ledger (variant_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
        VALUES ($1, $2, 'RESERVE', $3, 0.00, $4, 'Stock reserved via standard checkout', $5);
      `, [variantId, orderId, requestedQty, unitPrice, email]);

      // N. Save Idempotency Key record
      await this.saveIdempotency(idempotencyKey, authenticatedUserId, 'products/reserve', 'Order', orderId, queryRunner);

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      const responseObj = {
        success: true,
        orderId,
        bookingType: actualBookingType,
        advanceAmount: advPaid,
        remainingAmount: remaining
      };

      return responseObj;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async reserveProductsCart(dto: any, ipAddress: string, authenticatedUserId: string) {
    this.triggerLazyCleanup();

    const { items, name, instagram, phone, address, idempotencyKey, bookingType, advanceAmount } = dto;

    if (!authenticatedUserId) {
      throw new UnauthorizedException("Authentication is required to perform checkout.");
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestException("Cart items are required to checkout.");
    }

    // A. Resolve User details safely (No JWT Spoofing)
    const userRows = await this.dataSource.query("SELECT email FROM users WHERE id = $1", [authenticatedUserId]);
    if (userRows.length === 0) {
      throw new UnauthorizedException("Authenticated session user not found.");
    }
    const email = userRows[0].email;

    // B. Stateless DB Rate Limiting: max 3 requests per 10 seconds per user
    const rateCheck = await this.dataSource.query(`
      SELECT COUNT(*) as count FROM orders 
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '10 seconds';
    `, [authenticatedUserId]);
    if (Number(rateCheck[0].count) >= 3) {
      throw new HttpException({
        statusCode: 429,
        message: "Too many checkout attempts. Please wait a few seconds and try again."
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    // C. Check Idempotency Key
    const cacheRes = await this.checkIdempotency(idempotencyKey, authenticatedUserId);
    if (cacheRes) return cacheRes;

    // D. Sort items alphabetically by variantId to prevent transactional deadlocks
    const sortedItems = [...items].sort((a, b) => {
      const idA = a.variantId || '';
      const idB = b.variantId || '';
      return idA.localeCompare(idB);
    });

    // E. Resolve pricing and shipping charges purely on backend
    const pricing = await this.calculateCheckoutPricing({
      items: sortedItems,
      bookingType,
      advanceAmount
    });

    if (pricing.items.length === 0) {
      throw new BadRequestException("No valid products resolved for cart checkout.");
    }

    const firstGroupType = pricing.groups.some(g => g.bookingType === 'pre_order') ? 'pre_order' : 'standard';
    const clientVersions = dto.inventoryVersions || [];
    const clientVersionMap = new Map(clientVersions.map((cv: any) => [cv.id, Number(cv.version)]));

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // F. Get/create customer record
      const custRes = await queryRunner.query(`
        INSERT INTO customers (full_name, phone, instagram, address, email, city)
        VALUES ($1, $2, $3, $4, $5, 'Unknown')
        ON CONFLICT (email) DO UPDATE 
        SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, instagram = EXCLUDED.instagram, address = EXCLUDED.address
        RETURNING id;
      `, [name, phone, instagram, address, email.trim().toLowerCase()]);
      const customerId = custRes[0].id;

      // G. Create parent order records for each group
      const createdOrderIds = [];
      let firstOrderId = null;

      for (let i = 0; i < pricing.groups.length; i++) {
        const group = pricing.groups[i];
        const groupIsPreOrder = group.bookingType === 'pre_order';
        const orderStatus = groupIsPreOrder ? 'Pre-Order' : 'Pending';
        
        // Suffix idempotencyKey with _i to keep unique constraint satisfied
        const groupIdempotencyKey = `${idempotencyKey}_${i}`;

        const orderRes = await queryRunner.query(`
          INSERT INTO orders (user_id, total_price, shipping_address, status, booking_type, advance_amount, remaining_amount, shipping_cost, created_at, updated_at, idempotency_key)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9)
          RETURNING id;
        `, [authenticatedUserId, group.totalPrice, `${address} | Insta: ${instagram} | Phone: ${phone}`, orderStatus, group.bookingType, group.advanceAmount, group.remainingAmount, group.shippingFee, groupIdempotencyKey]);
        
        const orderId = orderRes[0].id;
        createdOrderIds.push(orderId);
        if (!firstOrderId) firstOrderId = orderId;

        // H. Create Order Event record
        await queryRunner.query(`
          INSERT INTO order_events (order_id, event_type, previous_status, new_status, details, performed_by)
          VALUES ($1, 'ORDER_CREATED', NULL, $2, 'Order created by cart checkout', $3);
        `, [orderId, orderStatus, email]);

        // I. Validate stock, lock stock, version control and create order items
        for (const resolvedItem of group.items) {
          const variantId = resolvedItem.variantId;
          const productId = resolvedItem.productId;
          const qtyNeeded = resolvedItem.qty;
          const unitPrice = resolvedItem.price;

          // Row-level lock variant and batches (FOR UPDATE)
          const varRows = await queryRunner.query(`
            SELECT id, product_id, total_stock, locked_stock, sold_stock, version 
            FROM product_variants 
            WHERE id = $1 AND deleted_at IS NULL 
            FOR UPDATE;
          `, [variantId]);

          if (varRows.length === 0) {
            throw new BadRequestException(`Casting variant for "${resolvedItem.name}" does not exist or has been archived.`);
          }

          const pv = varRows[0];
          const available = Number(pv.total_stock) - Number(pv.locked_stock || 0) - Number(pv.sold_stock);

          if (available <= 0) {
            throw new BadRequestException(`Casting "${resolvedItem.name}" is sold out.`);
          }

          if (qtyNeeded > available) {
            throw new BadRequestException(`Only ${available} unit(s) of "${resolvedItem.name}" are available. You requested ${qtyNeeded}.`);
          }

          // F. Version comparison check
          const clientVersion = clientVersionMap.get(variantId);
          if (clientVersion !== undefined && Number(pv.version) !== Number(clientVersion)) {
            throw new BadRequestException(`Inventory changed while you were checking out for "${resolvedItem.name}". Please review your order.`);
          }

          // Lock matching batches row-level
          await queryRunner.query(`
            SELECT id FROM inventory_batches 
            WHERE variant_id = $1 
            FOR UPDATE;
          `, [variantId]);

          // Check customer purchase limit
          const prodRows = await queryRunner.query("SELECT max_qty_per_customer FROM products WHERE id = $1 FOR UPDATE;", [productId]);
          const p = prodRows[0];
          if (p && p.max_qty_per_customer !== null && p.max_qty_per_customer > 0) {
            const existingCountRes = await queryRunner.query(`
              SELECT COALESCE(SUM(oi.qty), 0) as total
              FROM order_items oi
              JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = $1 
                AND o.user_id = $2 
                AND o.status NOT IN ('Cancelled', 'Expired');
            `, [productId, authenticatedUserId]);
            const existingCount = Number(existingCountRes[0].total);
            if (existingCount + qtyNeeded > p.max_qty_per_customer) {
              throw new BadRequestException(`Purchase limit exceeded for "${resolvedItem.name}". You have already ordered/reserved ${existingCount} items.`);
            }
          }

          // Create order item with snapshots
          await queryRunner.query(`
            INSERT INTO order_items (order_id, variant_id, product_id, qty, price_at_purchase, variant_name_snapshot, sku_snapshot, brand_snapshot, casing_snapshot, manufacturer_snapshot)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
          `, [orderId, variantId, productId, qtyNeeded, unitPrice, resolvedItem.variantName, resolvedItem.sku, resolvedItem.brand, resolvedItem.casing, resolvedItem.manufacturer]);

          // Lock stock (increment variant locked_stock and increment version)
          await queryRunner.query(`
            UPDATE product_variants 
            SET locked_stock = COALESCE(locked_stock, 0) + $1,
                updated_at = NOW() 
            WHERE id = $2;
          `, [qtyNeeded, variantId]);

          // Sync parent products aggregate cache
          await queryRunner.query(`
            UPDATE products p
            SET total_stock = (SELECT COALESCE(SUM(total_stock), 0) FROM product_variants WHERE product_id = p.id AND deleted_at IS NULL),
                locked_stock = (SELECT COALESCE(SUM(locked_stock), 0) FROM product_variants WHERE product_id = p.id AND deleted_at IS NULL),
                sold_stock = (SELECT COALESCE(SUM(sold_stock), 0) FROM product_variants WHERE product_id = p.id AND deleted_at IS NULL),
                updated_at = NOW()
            WHERE p.id = $1;
          `, [productId]);

          // Record in inventory ledger
          await queryRunner.query(`
            INSERT INTO inventory_ledger (variant_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
            VALUES ($1, $2, 'RESERVE', $3, 0.00, $4, 'Stock reserved via cart checkout', $5);
          `, [variantId, orderId, qtyNeeded, unitPrice, email]);
        }
      }

      // J. Clear the database cart for the user inside the transaction
      await queryRunner.query(`
        UPDATE cart_items 
        SET deleted_at = NOW(), updated_at = NOW() 
        WHERE cart_id = (SELECT id FROM carts WHERE user_id = $1) AND deleted_at IS NULL;
      `, [authenticatedUserId]);

      // K. Save Idempotency Key mapping
      await this.saveIdempotency(idempotencyKey, authenticatedUserId, 'products/reserve-cart', 'Order', firstOrderId, queryRunner);

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      const responseObj = {
        success: true,
        orderId: firstOrderId,
        orderIds: createdOrderIds,
        bookingType: firstGroupType,
        advanceAmount: pricing.advanceAmount,
        remainingAmount: pricing.remainingAmount
      };

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
    // 1. Fetch target order details
    const orderRows = await this.dataSource.query(
      "SELECT id, user_id, status, idempotency_key FROM orders WHERE id = $1 AND deleted_at IS NULL",
      [orderId]
    );
    if (orderRows.length === 0) throw new BadRequestException('Order not found.');
    const order = orderRows[0];

    // Check ownership
    if (order.user_id !== userId) {
      throw new UnauthorizedException('You do not have permission to upload screenshot for this order.');
    }

    // 2. Protect against expired/cancelled uploads
    if (order.status === 'Expired' || order.status === 'Cancelled' || order.status === 'Rejected') {
      throw new BadRequestException(`This order is already ${order.status.toLowerCase()}. You cannot upload payment receipts anymore.`);
    }

    // 3. File validation: extensions & max size (5MB)
    const allowedExts = ['jpg', 'jpeg', 'png', 'webp'];
    const ext = fileExtension.toLowerCase();
    if (!allowedExts.includes(ext)) {
      throw new BadRequestException("Invalid receipt file type. Only JPG, JPEG, PNG, and WebP images are allowed.");
    }
    if (fileBuffer.length > 5 * 1024 * 1024) {
      throw new BadRequestException("Receipt image size must not exceed 5MB.");
    }

    // 4. SHA256 receipt buffer deduplication (prevent duplicate uploads on retries)
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const existingReceipts = await this.dataSource.query(
      "SELECT id FROM order_payment_receipts WHERE file_hash = $1 LIMIT 1;",
      [fileHash]
    );
    if (existingReceipts.length > 0) {
      return { success: true, message: 'Receipt already uploaded previously.', receiptId: existingReceipts[0].id };
    }

    const fileName = `${crypto.randomUUID()}.${ext}`;
    
    // 5. Save receipt file (S3 or local filesystem)
    if (process.env.S3_PRIVATE_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
          region: process.env.AWS_REGION?.trim() || 'ap-south-1'
        });
        const bucket = process.env.S3_PRIVATE_BUCKET.trim();
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `uploads/${fileName}`,
          Body: fileBuffer,
          ContentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`
        }));
      } catch (err: any) {
        console.error(`[S3] Failed to upload screenshot to S3: ${err.message}`);
        throw err;
      }
    } else {
      const filePath = path.join(privateUploadDir, fileName);
      fs.writeFileSync(filePath, fileBuffer);
    }

    // Resolve user email
    const userRows = await this.dataSource.query("SELECT email FROM users WHERE id = $1", [userId]);
    const userEmail = userRows[0]?.email || 'User';

    // 6. Find ALL sibling orders created in the same transaction split
    let siblingOrderIds = [orderId];
    if (order.idempotency_key && order.idempotency_key.includes('_')) {
      const parts = order.idempotency_key.split('_');
      if (parts.length > 0) {
        const prefix = parts[0] + '_';
        const siblings = await this.dataSource.query(
          "SELECT id FROM orders WHERE idempotency_key LIKE $1 AND user_id = $2 AND deleted_at IS NULL",
          [`${prefix}%`, order.user_id]
        );
        siblingOrderIds = siblings.map(s => s.id);
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 7. Update status, store receipts and write event trails
      for (const oid of siblingOrderIds) {
        // A. Insert receipt record
        const receiptRes = await queryRunner.query(`
          INSERT INTO order_payment_receipts (order_id, screenshot_url, file_hash, status, uploaded_by)
          VALUES ($1, $2, $3, 'Pending', $4)
          RETURNING id;
        `, [oid, fileName, fileHash, userId]);
        const receiptId = receiptRes[0].id;

        // B. Fetch previous order status
        const statusCheck = await queryRunner.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE;", [oid]);
        const previousStatus = statusCheck[0]?.status || 'Pending';

        // C. Update order status to Awaiting Confirmation
        await queryRunner.query(`
          UPDATE orders 
          SET status = 'Awaiting Confirmation', screenshot_url = $1, updated_at = NOW()
          WHERE id = $2;
        `, [fileName, oid]);

        // D. Insert Payment Event record
        await queryRunner.query(`
          INSERT INTO payment_events (order_id, event_type, receipt_id, details, performed_by)
          VALUES ($1, 'RECEIPT_UPLOADED', $2, 'Uploaded payment confirmation receipt screenshot', $3);
        `, [oid, receiptId, userEmail]);

        // E. Insert Order Event record
        await queryRunner.query(`
          INSERT INTO order_events (order_id, event_type, previous_status, new_status, details, performed_by)
          VALUES ($1, 'STATUS_CHANGE', $2, 'Awaiting Confirmation', 'Payment confirmation receipt uploaded, awaiting admin review', $3);
        `, [oid, previousStatus, userEmail]);

        // Send admin notification alert
        await this.createSystemNotification(
          'Payment Uploaded',
          `Order ${oid.slice(0, 8)} uploaded a transaction receipt. Pending verification.`,
          'payment',
          oid,
          queryRunner
        );
      }

      await queryRunner.commitTransaction();
      return { success: true };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      console.error("[Screenshot] Transaction failed to save receipt:", e.message);
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  async getPrivateScreenshotStream(orderId: string) {
    const rows = await this.dataSource.query(
      "SELECT screenshot_url, advance_screenshot_url FROM orders WHERE id = $1", 
      [orderId]
    );
    if (rows.length === 0) return null;
    
    const fileName = rows[0].screenshot_url || rows[0].advance_screenshot_url;
    if (!fileName) return null;

    if (process.env.S3_PRIVATE_BUCKET) {
      try {
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const res = await s3.send(new GetObjectCommand({
          Bucket: process.env.S3_PRIVATE_BUCKET,
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
        const bucket = process.env.S3_ASSETS_BUCKET.trim();
        const s3 = new S3Client({
          region: process.env.AWS_REGION?.trim() || 'ap-south-1'
        });
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `uploads/${fileName}`,
          Body: fileBuffer,
          ContentType: mimetype
        }));
        console.log(`[S3] Uploaded public image: ${fileName}`);
        return `https://${bucket}.s3.amazonaws.com/uploads/${fileName}`;
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
        const s3 = new S3Client({
          region: process.env.AWS_REGION?.trim() || 'ap-south-1'
        });
        const res = await s3.send(new GetObjectCommand({
          Bucket: process.env.S3_ASSETS_BUCKET.trim(),
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
  async expireActiveOrders() {
    // 1. Fetch reservation timeout hours from settings (fallback to 24)
    let timeoutHours = 24;
    try {
      const rowsSettings = await this.dataSource.query("SELECT value FROM global_settings WHERE key = 'app_settings';");
      const settings = rowsSettings.length > 0 ? rowsSettings[0].value : {};
      if (settings.reservation_timeout_hours !== undefined && !isNaN(Number(settings.reservation_timeout_hours))) {
        timeoutHours = Number(settings.reservation_timeout_hours);
      }
    } catch (e) {
      console.warn("[Expiry] Failed to fetch reservation_timeout_hours from settings, falling back to 24:", e.message);
    }

    // 2. Fetch all expired orders ('Pending' or unpaid 'Pre-Order' without screenshot)
    const expiredOrders = await this.dataSource.query(`
      SELECT o.id, o.status, o.user_id, u.email
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE (o.status = 'Pending' OR (o.status = 'Pre-Order' AND NOT EXISTS (
        SELECT 1 FROM order_payment_receipts WHERE order_id = o.id
      )))
        AND o.created_at + ($1 || ' hours')::INTERVAL < NOW()
        AND o.deleted_at IS NULL;
    `, [timeoutHours]);

    for (const order of expiredOrders) {
      console.log(`[Expiry Worker] Expiring order ID: ${order.id} for user: ${order.email}`);
      
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        // A. Set status to Expired
        await queryRunner.query("UPDATE orders SET status = 'Expired', updated_at = NOW() WHERE id = $1", [order.id]);

        // B. Record Order Event
        await queryRunner.query(`
          INSERT INTO order_events (order_id, event_type, previous_status, new_status, details, performed_by)
          VALUES ($1, 'ORDER_EXPIRED', $2, 'Expired', 'Order expired due to payment timeout', 'System Worker');
        `, [order.id, order.status]);

        // C. Fetch items to release stock locks
        const items = await queryRunner.query('SELECT product_id, variant_id, qty FROM order_items WHERE order_id = $1', [order.id]);
        for (const item of items) {
          // Release variant locked stock and increment version
          await queryRunner.query(`
            UPDATE product_variants
            SET locked_stock = GREATEST(0, locked_stock - $1),
                updated_at = NOW()
            WHERE id = $2;
          `, [item.qty, item.variant_id]);

          // Sync parent product aggregate cache
          await queryRunner.query(`
            UPDATE products p
            SET locked_stock = (SELECT COALESCE(SUM(locked_stock), 0) FROM product_variants WHERE product_id = p.id AND deleted_at IS NULL),
                updated_at = NOW()
            WHERE p.id = $1;
          `, [item.product_id]);

          // Record in inventory ledger
          await queryRunner.query(`
            INSERT INTO inventory_ledger (variant_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
            VALUES ($1, $2, 'RELEASE_RESERVATION', $3, 0.00, 0.00, 'Released stock lock due to order expiration', 'System Worker');
          `, [item.variant_id, order.id, item.qty]);
        }

        await queryRunner.commitTransaction();
      } catch (err) {
        await queryRunner.rollbackTransaction();
        console.error(`[Expiry Worker] Rollback failed for order: ${order.id}:`, err);
      } finally {
        await queryRunner.release();
      }
    }

    // 3. Clean up abandoned soft-deleted cart items older than 90 days
    try {
      await this.dataSource.query(`
        DELETE FROM cart_items
        WHERE deleted_at IS NOT NULL AND updated_at < NOW() - INTERVAL '90 days';
      `);
    } catch (e) {
      console.error("[Expiry Worker] Failed to prune soft-deleted cart items:", e.message);
    }

    // 4. Release global localCache keys
    localCache.del('products_list_true');
    localCache.del('products_list_false');
  }

  // ── NON-BLOCKING LAZY CLEANUP RATE LIMITER ─────────────────────────
  triggerLazyCleanup() {
    const now = Date.now();
    if (now - this.lastCleanupAt > 5 * 60 * 1000) { // 5 minutes
      this.lastCleanupAt = now;
      // Execute asynchronously in background (non-blocking)
      this.expireActiveOrders().catch(err => {
        console.error("[Expiry] Asynchronous lazy expiration failed:", err);
      });
    }
  }

  // ── DATABASE-BACKED USER CARTS SERVICES ────────────────────────────
  async getOrCreateCart(userId: string, queryRunner?: any): Promise<string> {
    const conn = queryRunner || this.dataSource;
    const existing = await conn.query("SELECT id FROM carts WHERE user_id = $1 LIMIT 1;", [userId]);
    if (existing.length > 0) return existing[0].id;

    const res = await conn.query("INSERT INTO carts (user_id) VALUES ($1) RETURNING id;", [userId]);
    return res[0].id;
  }

  async getUserCart(userId: string) {
    const cartId = await this.getOrCreateCart(userId);
    // Fetch active items, join with variant & product info to get dynamic price, availability and metadata
    return this.dataSource.query(`
      SELECT 
        ci.id as "cartItemId",
        ci.variant_id as "id", -- matches frontend item.id expectations
        ci.variant_id as "variantId",
        ci.quantity,
        pv.product_id as "productId",
        COALESCE(pv.name, ci.product_name_snapshot) as name,
        COALESCE(pi.thumbnail_url, ci.image_snapshot) as image,
        COALESCE(pv.selling_price, ci.price_snapshot)::float as price,
        COALESCE(p.brand, ci.brand_snapshot) as brand,
        p.scale,
        p.is_prebook as "isPrebook",
        p.is_prebook as "is_prebook",
        (pv.total_stock - pv.locked_stock - pv.sold_stock)::int as "availableStock"
      FROM cart_items ci
      JOIN product_variants pv ON pv.id = ci.variant_id
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE ci.cart_id = $1 AND ci.deleted_at IS NULL
      ORDER BY ci.created_at ASC;
    `, [cartId]);
  }

  async upsertCartItem(
    userId: string,
    variantId: string,
    quantity: number,
    mode: 'add' | 'set',
    snapshot?: { productName?: string; imageUrl?: string; price?: number; brand?: string }
  ) {
    const cartId = await this.getOrCreateCart(userId);
    const qty = Math.max(1, parseInt(quantity as any || '1', 10));

    // Check variant availability
    const varRows = await this.dataSource.query(`
      SELECT pv.product_id, (pv.total_stock - pv.locked_stock - pv.sold_stock) as available 
      FROM product_variants pv 
      WHERE pv.id = $1 AND pv.deleted_at IS NULL;
    `, [variantId]);

    if (varRows.length === 0) {
      throw new BadRequestException("Casting variant does not exist or has been archived.");
    }
    const maxAvailable = Number(varRows[0].available);
    const productId = varRows[0].product_id;

    // Check if item already exists
    const existing = await this.dataSource.query(
      "SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND variant_id = $2 AND deleted_at IS NULL LIMIT 1;",
      [cartId, variantId]
    );

    let targetQty = qty;
    if (existing.length > 0) {
      targetQty = mode === 'add' ? Number(existing[0].quantity) + qty : qty;
    }

    if (targetQty > maxAvailable) {
      throw new BadRequestException(`Only ${maxAvailable} unit(s) are available. You requested ${targetQty}.`);
    }

    if (existing.length > 0) {
      await this.dataSource.query(`
        UPDATE cart_items
        SET quantity = $1, updated_at = NOW()
        WHERE id = $2;
      `, [targetQty, existing[0].id]);
    } else {
      await this.dataSource.query(`
        INSERT INTO cart_items (cart_id, variant_id, quantity, product_name_snapshot, image_snapshot, price_snapshot, brand_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `, [
        cartId,
        variantId,
        targetQty,
        snapshot?.productName || null,
        snapshot?.imageUrl || null,
        snapshot?.price ? Number(snapshot.price) : null,
        snapshot?.brand || null
      ]);
    }

    return this.getUserCart(userId);
  }

  async deleteCartItem(userId: string, variantId: string) {
    const cartId = await this.getOrCreateCart(userId);
    await this.dataSource.query(`
      UPDATE cart_items
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE cart_id = $1 AND variant_id = $2 AND deleted_at IS NULL;
    `, [cartId, variantId]);
    return this.getUserCart(userId);
  }

  async clearUserCartDb(userId: string) {
    const cartId = await this.getOrCreateCart(userId);
    await this.dataSource.query(`
      UPDATE cart_items
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE cart_id = $1 AND deleted_at IS NULL;
    `, [cartId]);
    return { success: true };
  }

  async mergeCart(userId: string, items: Array<{ variantId: string; quantity: number; productName?: string; imageUrl?: string; price?: number; brand?: string }>) {
    const cartId = await this.getOrCreateCart(userId);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      for (const item of items) {
        if (!item.variantId) continue;
        const qty = Math.max(1, parseInt(item.quantity as any || '1', 10));

        // Get availability
        const varRows = await queryRunner.query(`
          SELECT (pv.total_stock - pv.locked_stock - pv.sold_stock) as available 
          FROM product_variants pv 
          WHERE pv.id = $1 AND pv.deleted_at IS NULL FOR UPDATE;
        `, [item.variantId]);

        if (varRows.length === 0) continue; // skip deleted variants
        const available = Number(varRows[0].available);

        // Check existing item
        const existing = await queryRunner.query(
          "SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND variant_id = $2 AND deleted_at IS NULL FOR UPDATE LIMIT 1;",
          [cartId, item.variantId]
        );

        let targetQty = qty;
        if (existing.length > 0) {
          targetQty = Number(existing[0].quantity) + qty;
        }
        targetQty = Math.min(targetQty, available); // respect stock limit

        if (targetQty > 0) {
          if (existing.length > 0) {
            await queryRunner.query("UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2;", [targetQty, existing[0].id]);
          } else {
            await queryRunner.query(`
              INSERT INTO cart_items (cart_id, variant_id, quantity, product_name_snapshot, image_snapshot, price_snapshot, brand_snapshot)
              VALUES ($1, $2, $3, $4, $5, $6, $7);
            `, [
              cartId,
              item.variantId,
              targetQty,
              item.productName || null,
              item.imageUrl || null,
              item.price ? Number(item.price) : null,
              item.brand || null
            ]);
          }
        }
      }
      await queryRunner.commitTransaction();
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }

    return this.getUserCart(userId);
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
      JOIN product_variants pv ON pv.id = oi.variant_id
      JOIN products p ON p.id = pv.product_id
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
      JOIN product_variants pv ON pv.id = oi.variant_id
      JOIN products p ON p.id = pv.product_id
      JOIN users u ON u.id = o.user_id
      WHERE u.email = $1 AND o.deleted_at IS NULL
      ORDER BY o.created_at DESC;
    `, [email.trim().toLowerCase()]);
  }
  validateOrderTransition(currentStatus: string, nextStatus: string, role?: string) {
    if (currentStatus === nextStatus) return;

    const validTransitions: Record<string, string[]> = {
      'Pending': ['Awaiting Confirmation', 'Confirmed', 'Cancelled', 'Expired'],
      'Pre-Order': ['Awaiting Confirmation', 'Cancelled'],
      'Awaiting Stock': ['Awaiting Confirmation', 'Cancelled'],
      'Awaiting Confirmation': ['Confirmed', 'Cancelled', 'Rejected'],
      'Confirmed': ['Packed', 'Cancelled'],
      'Packed': ['Shipped', 'Cancelled'],
      'Shipped': ['Delivered', 'Cancelled'],
      'Delivered': [],
      'Cancelled': [],
      'Expired': [],
      'Rejected': []
    };

    const allowed = validTransitions[currentStatus] || [];
    if (!allowed.includes(nextStatus)) {
      throw new BadRequestException(`Illegal order state transition from "${currentStatus}" to "${nextStatus}".`);
    }

    // Role-based constraints
    if (role) {
      if (['Confirmed', 'Cancelled', 'Rejected', 'Expired'].includes(nextStatus)) {
        if (role !== 'Owner' && role !== 'Admin' && role !== 'System') {
          throw new ForbiddenException(`Users with role "${role}" are not permitted to transition orders to "${nextStatus}".`);
        }
      }
      if (['Packed', 'Shipped', 'Delivered'].includes(nextStatus)) {
        if (role !== 'Owner' && role !== 'Admin' && role !== 'Warehouse') {
          throw new ForbiddenException(`Users with role "${role}" are not permitted to transition orders to "${nextStatus}".`);
        }
      }
    }
  }

  async adminConfirmOrder(orderId: string, adminEmail: string, ipAddress: string, role?: string) {
    const oldRes = await this.dataSource.query("SELECT status, booking_type FROM orders WHERE id = $1", [orderId]);
    if (oldRes.length === 0) {
      throw new Error("Order not found.");
    }
    
    this.validateOrderTransition(oldRes[0].status, 'Confirmed', role);

    if (oldRes[0].status === 'Confirmed' || oldRes[0].status === 'Pre-Order') {
      return { success: true };
    }
    
    const bookingType = oldRes[0].booking_type;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get order items
      const items = await queryRunner.query('SELECT id as "orderItemId", product_id, qty, price_at_purchase as "priceAtPurchase", variant_id FROM order_items WHERE order_id = $1', [orderId]);
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
          SELECT id, purchase_price, quantity_available, quantity_reserved
          FROM inventory_batches
          WHERE variant_id = $1 AND quantity_available > 0
          ORDER BY received_at ASC
          FOR UPDATE;
        `, [item.variant_id || item.product_id]);
        
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
          `, [item.orderItemId, b.id, allocQty, Number(b.purchase_price), Number(item.priceAtPurchase || 0)]);
          
          // Record ledger RESERVE
          await queryRunner.query(`
            INSERT INTO inventory_ledger (variant_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
            VALUES ($1, $2, $3, 'RESERVE', $4, $5, $6, $7, $8);
          `, [item.variant_id, b.id, orderId, -allocQty, Number(b.purchase_price), Number(item.priceAtPurchase || 0), `Reserved stock for order approval`, adminEmail || 'System']);
          
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

      // Update payment receipt status to Approved
      await queryRunner.query(`
        UPDATE order_payment_receipts 
        SET status = 'Approved', updated_at = NOW() 
        WHERE order_id = $1 AND status = 'Pending';
      `, [orderId]);

      // Write Payment Event
      await queryRunner.query(`
        INSERT INTO payment_events (order_id, event_type, details, performed_by)
        VALUES ($1, 'RECEIPT_APPROVED', 'Payment receipt approved by administrator', $2);
      `, [orderId, adminEmail]);

      // Write Order Event
      await queryRunner.query(`
        INSERT INTO order_events (order_id, event_type, previous_status, new_status, details, performed_by)
        VALUES ($1, 'STATUS_CHANGE', $2, $3, 'Order confirmed and stock allocated via admin approval', $4);
      `, [orderId, oldRes[0].status, targetStatus, adminEmail]);

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
  async adminUpdateOrderStatus(orderId: string, fields: any, adminEmail: string, ipAddress: string, role?: string) {
    const oldRes = await this.dataSource.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    if (oldRes.length === 0) throw new BadRequestException('Order not found.');
    const old = oldRes[0];

    const targetStatus = fields.status || old.status;

    if (fields.status) {
      this.validateOrderTransition(old.status, fields.status, role);
    }

    // Enforce courier details when shipping
    if (targetStatus === 'Shipped' && (!fields.courierPartner || !fields.trackingNumber)) {
      throw new BadRequestException("Courier partner and tracking number are required to ship this order.");
    }

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
        targetStatus,
        fields.courierPartner || old.courier_partner,
        fields.trackingNumber || old.tracking_number,
        fields.shippingCost !== undefined ? Number(fields.shippingCost) : old.shipping_cost,
        fields.packagingCost !== undefined ? Number(fields.packagingCost) : old.packaging_cost,
        fields.dispatchDate || old.dispatch_date,
        fields.deliveryDate || old.delivery_date,
        orderId
      ]);

      // Write Order Event trail
      await queryRunner.query(`
        INSERT INTO order_events (order_id, event_type, previous_status, new_status, details, performed_by)
        VALUES ($1, 'STATUS_CHANGE', $2, $3, $4, $5);
      `, [orderId, old.status, targetStatus, `Order status updated to ${targetStatus}`, adminEmail]);

      // If status transitioned to Paid, Confirmed, Shipped, or Delivered, mark receipt as paid
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
      if ((targetStatus === 'Shipped' || targetStatus === 'Delivered') && (old.status === 'Confirmed' || old.status === 'Packed')) {
        const allocations = await queryRunner.query(`
          SELECT a.*, oi.product_id, oi.variant_id 
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
            INSERT INTO inventory_ledger (variant_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
            VALUES ($1, $2, $3, 'SELL', 0, $4, $5, $6, $7);
          `, [a.variant_id || a.product_id, a.batch_id, orderId, Number(a.purchase_price), Number(a.selling_price), `Shipped/Delivered stock finalized`, adminEmail || 'System']);

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
          SELECT a.*, oi.product_id, oi.variant_id 
          FROM order_inventory_allocations a
          JOIN order_items oi ON oi.id = a.order_item_id
          WHERE oi.order_id = $1;
        `, [orderId]);

        for (const a of allocations) {
          if (old.status === 'Confirmed' || old.status === 'Pre-Order' || old.status === 'Packed') {
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
              INSERT INTO inventory_ledger (variant_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
              VALUES ($1, $2, $3, 'RELEASE_RESERVATION', $4, $5, $6, $7, $8);
            `, [a.variant_id || a.product_id, a.batch_id, orderId, a.quantity, Number(a.purchase_price), Number(a.selling_price), `Released reservation from cancelled order`, adminEmail || 'System']);

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
              INSERT INTO inventory_ledger (variant_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
              VALUES ($1, $2, $3, 'RETURN_CUSTOMER', $4, $5, $6, $7, $8);
            `, [a.variant_id || a.product_id, a.batch_id, orderId, a.quantity, Number(a.purchase_price), Number(a.selling_price), `Returned stock from cancelled order`, adminEmail || 'System']);

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

        if (old.status === 'Confirmed' || old.status === 'Pre-Order' || old.status === 'Packed' || old.status === 'Shipped' || old.status === 'Delivered') {
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

      // Update last Pending payment receipt if Rejected or Cancelled
      if (targetStatus === 'Cancelled' || targetStatus === 'Rejected') {
        await queryRunner.query(`
          UPDATE order_payment_receipts 
          SET status = 'Rejected', updated_at = NOW() 
          WHERE order_id = $1 AND status = 'Pending';
        `, [orderId]);

        await queryRunner.query(`
          INSERT INTO payment_events (order_id, event_type, details, performed_by)
          VALUES ($1, 'RECEIPT_REJECTED', 'Payment receipt automatically rejected due to order cancellation/rejection', $2);
        `, [orderId, adminEmail]);
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
    
    if (process.env.S3_PRIVATE_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_PRIVATE_BUCKET,
          Key: `uploads/${fileName}`,
          Body: fileBuffer,
          ContentType: `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`
        }));
        console.log(`[S3] Successfully uploaded remaining payment evidence ${fileName}.`);
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

    // A. File validation: extensions & max size (5MB)
    const allowedExts = ['jpg', 'jpeg', 'png', 'webp'];
    const ext = fileExtension.toLowerCase();
    if (!allowedExts.includes(ext)) {
      throw new BadRequestException("Invalid receipt file type. Only JPG, JPEG, PNG, and WebP images are allowed.");
    }
    if (fileBuffer.length > 5 * 1024 * 1024) {
      throw new BadRequestException("Receipt image size must not exceed 5MB.");
    }

    // B. SHA256 hash deduplication check
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const existingReceipts = await this.dataSource.query(
      "SELECT id FROM order_payment_receipts WHERE file_hash = $1 LIMIT 1;",
      [fileHash]
    );
    if (existingReceipts.length > 0) {
      return { success: true, message: 'Receipt already uploaded previously.', receiptId: existingReceipts[0].id };
    }

    const fileName = `remain_${crypto.randomUUID()}.${ext}`;
    
    // C. Save receipt file
    if (process.env.S3_PRIVATE_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_PRIVATE_BUCKET,
          Key: `uploads/${fileName}`,
          Body: fileBuffer,
          ContentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`
        }));
      } catch (err: any) {
        console.error(`[S3] Failed to upload remaining screenshot to S3: ${err.message}`);
        throw err;
      }
    } else {
      const filePath = path.join(privateUploadDir, fileName);
      fs.writeFileSync(filePath, fileBuffer);
    }

    // Resolve user email
    const userRows = await this.dataSource.query("SELECT email FROM users WHERE id = $1", [userId]);
    const userEmail = userRows[0]?.email || 'User';

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // D. Insert receipt record
      const receiptRes = await queryRunner.query(`
        INSERT INTO order_payment_receipts (order_id, screenshot_url, file_hash, status, uploaded_by)
        VALUES ($1, $2, $3, 'Pending', $4)
        RETURNING id;
      `, [orderId, fileName, fileHash, userId]);
      const receiptId = receiptRes[0].id;

      // E. Update order status to Awaiting Confirmation
      await queryRunner.query(`
        UPDATE orders
        SET advance_screenshot_url = $1,
            status = 'Awaiting Confirmation',
            updated_at = NOW()
        WHERE id = $2;
      `, [fileName, orderId]);

      // F. Insert Payment Event record
      await queryRunner.query(`
        INSERT INTO payment_events (order_id, event_type, receipt_id, details, performed_by)
        VALUES ($1, 'RECEIPT_UPLOADED', $2, 'Uploaded remaining payment confirmation receipt screenshot', $3);
      `, [orderId, receiptId, userEmail]);

      // G. Insert Order Event record
      await queryRunner.query(`
        INSERT INTO order_events (order_id, event_type, previous_status, new_status, details, performed_by)
        VALUES ($1, 'STATUS_CHANGE', 'Awaiting Stock', 'Awaiting Confirmation', 'Remaining payment confirmation receipt uploaded, awaiting admin review', $3);
      `, [orderId, userEmail]);

      await queryRunner.commitTransaction();

      await this.createSystemNotification(
        'Pre-Order: Remaining Payment Uploaded',
        `Customer has uploaded remaining payment receipt for Order ${orderId.slice(0, 8)}. Verification required.`,
        'payment',
        orderId
      );

      return { success: true };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      console.error("[Screenshot] Remaining payment transaction failed:", e.message);
      throw e;
    } finally {
      await queryRunner.release();
    }
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
  async getCustomers(search?: string) {
    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      return this.dataSource.query(`
        SELECT DISTINCT ON (LOWER(name)) *
        FROM (
          SELECT c.id, 
                 c.full_name as name, 
                 c.phone, 
                 c.email, 
                 c.instagram as insta, 
                 c.address,
                 c.created_at
          FROM customers c
          WHERE c.deleted_at IS NULL AND (
            LOWER(c.full_name) LIKE LOWER($1) OR
            LOWER(c.phone) LIKE LOWER($1) OR
            LOWER(c.email) LIKE LOWER($1) OR
            LOWER(c.instagram) LIKE LOWER($1)
          )
          UNION ALL
          SELECT r.id, 
                 r.customer_name as name, 
                 r.customer_phone as phone, 
                 COALESCE(r.customer_email, '') as email, 
                 r.customer_instagram as insta, 
                 r.customer_address as address,
                 r.created_at
          FROM receipts r
          WHERE r.customer_name IS NOT NULL AND r.customer_name != '' AND (
            LOWER(r.customer_name) LIKE LOWER($1) OR
            LOWER(r.customer_phone) LIKE LOWER($1) OR
            LOWER(COALESCE(r.customer_email, '')) LIKE LOWER($1) OR
            LOWER(r.customer_instagram) LIKE LOWER($1)
          )
        ) combined
        ORDER BY LOWER(name), created_at DESC
        LIMIT 15;
      `, [q]);
    }

    return this.dataSource.query(`
      SELECT c.id, c.full_name as name, c.instagram as "instagramUsername", c.phone, c.email, c.city, c.notes, c.created_at as "createdAt",
             COALESCE(COUNT(o.id) FILTER (WHERE o.status = 'Confirmed' OR o.status = 'Shipped' OR o.status = 'Delivered'), 0) as "totalOrders",
             COALESCE(SUM(o.total_price) FILTER (WHERE o.status = 'Confirmed' OR o.status = 'Shipped' OR o.status = 'Delivered'), 0) as "totalSpend",
             MAX(o.created_at) FILTER (WHERE o.status = 'Confirmed' OR o.status = 'Shipped' OR o.status = 'Delivered') as "lastOrderDate"
      FROM customers c
      LEFT JOIN users u ON u.email = c.email
      LEFT JOIN orders o ON o.user_id = u.id
      WHERE c.deleted_at IS NULL
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

    if (filters.cashAccountId && filters.cashAccountId !== 'all') {
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

  async getDashboardAggregates() {
    const settings = await this.getGlobalSettings();
    const threshold = settings.lowStockThreshold || 3;

    const availableRes = await this.dataSource.query('SELECT COALESCE(SUM(quantity_available), 0)::int as total FROM inventory_batches WHERE status != \'Archived\';');
    const availableInventory = availableRes[0].total;

    const incomingRes = await this.dataSource.query(`
      SELECT COALESCE(GREATEST(0, 
        (
          SELECT SUM(spi.quantity)
          FROM supplier_purchase_items spi
          JOIN supplier_purchases sp ON sp.id = spi.supplier_purchase_id
          WHERE sp.status NOT IN ('Draft', 'Cancelled', 'Completed')
        ) - COALESCE(
          (
            SELECT SUM(ib_rec.quantity_received)
            FROM inventory_batches ib_rec
            JOIN supplier_purchases sp_rec ON sp_rec.id = ib_rec.supplier_purchase_id
            WHERE sp_rec.status NOT IN ('Draft', 'Cancelled', 'Completed')
              AND ib_rec.status != 'Archived'
          ), 0
        )
      ), 0)::int as total;
    `);
    const incomingInventory = incomingRes[0].total;

    const poRes = await this.dataSource.query('SELECT COUNT(*)::int as total FROM supplier_purchases WHERE status NOT IN (\'Draft\', \'Cancelled\', \'Completed\');');
    const totalPurchaseOrders = poRes[0].total;

    const valRes = await this.dataSource.query('SELECT COALESCE(SUM(quantity_available * purchase_price), 0.00)::float as total FROM inventory_batches WHERE status != \'Archived\';');
    const totalInventoryValue = valRes[0].total;

    const lowStockRes = await this.dataSource.query(`
      WITH variant_stock AS (
        SELECT pv.id, COALESCE(SUM(ib.quantity_available), 0) as stock
        FROM product_variants pv
        LEFT JOIN inventory_batches ib ON ib.variant_id = pv.id AND ib.status != 'Archived'
        WHERE pv.deleted_at IS NULL
        GROUP BY pv.id
      )
      SELECT COUNT(*)::int as total FROM variant_stock WHERE stock <= $1;
    `, [threshold]);
    const lowStockAlerts = lowStockRes[0].total;

    const preorderRes = await this.dataSource.query(`
      SELECT COUNT(pv.id)::int as total 
      FROM product_variants pv 
      JOIN products p ON p.id = pv.product_id 
      WHERE p.is_prebook = true 
        AND pv.deleted_at IS NULL 
        AND p.deleted_at IS NULL;
    `);
    const preorderCount = preorderRes[0].total;

    const noSkuRes = await this.dataSource.query('SELECT COUNT(*)::int as total FROM products WHERE deleted_at IS NULL AND (sku IS NULL OR sku = \'\');');
    const productsWithoutSKU = noSkuRes[0].total;

    const noPriceRes = await this.dataSource.query('SELECT COUNT(*)::int as total FROM product_variants WHERE deleted_at IS NULL AND (selling_price IS NULL OR selling_price <= 0);');
    const productsWithoutPrice = noPriceRes[0].total;

    const receiptInsights = await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND pending_balance > 0)::int AS "pendingReceiptCount",
        COALESCE(SUM(pending_balance) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND pending_balance > 0), 0)::float AS "pendingReceiptBalance",
        COUNT(*) FILTER (WHERE status = 'Voided')::int AS "voidedReceiptCount",
        COUNT(*) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided')::int AS "totalReceiptsCount",
        COUNT(*) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND LOWER(COALESCE(format_type, 'standard')) NOT IN ('prebooking', 'pre_order', 'po'))::int AS "standardCount",
        COUNT(*) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND LOWER(COALESCE(format_type, 'standard')) IN ('prebooking', 'pre_order', 'po'))::int AS "poCount",
        COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND LOWER(COALESCE(format_type, 'standard')) NOT IN ('prebooking', 'pre_order', 'po')), 0)::float AS "stockRevenue",
        COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND LOWER(COALESCE(format_type, 'standard')) IN ('prebooking', 'pre_order', 'po')), 0)::float AS "poRevenue",
        COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided'), 0)::float AS "totalRevenue",
        COALESCE(AVG(total_amount) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided'), 0)::float AS "avgReceiptValue",
        COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND COALESCE(receipt_date, created_at) >= DATE_TRUNC('month', CURRENT_DATE)), 0)::float AS "thisMonthRevenue",
        COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND COALESCE(receipt_date, created_at) >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month' AND COALESCE(receipt_date, created_at) < DATE_TRUNC('month', CURRENT_DATE)), 0)::float AS "lastMonthRevenue",
        COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND COALESCE(receipt_date, created_at) >= CURRENT_DATE - INTERVAL '6 days'), 0)::float AS "thisWeekRevenue",
        COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status, 'Issued') <> 'Voided' AND COALESCE(receipt_date, created_at) >= CURRENT_DATE - INTERVAL '13 days' AND COALESCE(receipt_date, created_at) < CURRENT_DATE - INTERVAL '6 days'), 0)::float AS "lastWeekRevenue"
      FROM receipts;
    `);
    const receiptChartQuery = (startExpression: string, step: string, count: number, labelExpression: string) => `
      WITH buckets AS (
        SELECT generate_series(${startExpression}, ${startExpression} + INTERVAL '${count - 1} ${step}', INTERVAL '1 ${step}') AS bucket_start
      )
      SELECT
        ${labelExpression} AS label,
        COALESCE(SUM(r.total_amount) FILTER (WHERE LOWER(COALESCE(r.format_type, 'standard')) NOT IN ('prebooking', 'pre_order', 'po')), 0)::float AS stock,
        COALESCE(SUM(r.total_amount) FILTER (WHERE LOWER(COALESCE(r.format_type, 'standard')) IN ('prebooking', 'pre_order', 'po')), 0)::float AS po,
        COALESCE(SUM(r.total_amount), 0)::float AS total
      FROM buckets b
      LEFT JOIN receipts r
        ON COALESCE(r.receipt_date, r.created_at) >= b.bucket_start
       AND COALESCE(r.receipt_date, r.created_at) < b.bucket_start + INTERVAL '1 ${step}'
       AND COALESCE(r.status, 'Issued') <> 'Voided'
      GROUP BY b.bucket_start
      ORDER BY b.bucket_start;
    `;
    const [dailyReceiptChart, weeklyReceiptChart, monthlyReceiptChart] = await Promise.all([
      this.dataSource.query(receiptChartQuery("CURRENT_DATE - INTERVAL '6 days'", 'day', 7, "CASE WHEN b.bucket_start::date = CURRENT_DATE THEN 'Today' ELSE TO_CHAR(b.bucket_start, 'Dy DD Mon') END")),
      this.dataSource.query(receiptChartQuery("DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '7 weeks'", 'week', 8, "TO_CHAR(b.bucket_start, 'DD Mon')")),
      this.dataSource.query(receiptChartQuery("DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'", 'month', 12, "TO_CHAR(b.bucket_start, 'Mon YY')"))
    ]);
    const failedReceiptJobs = await this.dataSource.query(`
      SELECT COUNT(*)::int AS total
      FROM receipt_generation_jobs
      WHERE status = 'Failed' OR retry_count >= max_retries;
    `);
    const overduePurchases = await this.dataSource.query(`
      SELECT COUNT(*)::int AS total
      FROM supplier_purchases
      WHERE status NOT IN ('Draft', 'Cancelled', 'Completed')
        AND expected_arrival_date IS NOT NULL
        AND expected_arrival_date < CURRENT_DATE;
    `);

    // Gross profits & average margins
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);

    const revTodayRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger
      WHERE type IN ('Customer Payment', 'Pre-order Advance', 'Pre-order Remaining Payment')
        AND status = 'Completed'
        AND date BETWEEN $1 AND $2
    `, [todayStart, todayEnd]);
    const revToday = revTodayRes[0].total;

    const cogsTodayRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(a.quantity * a.purchase_price), 0)::float as total
      FROM order_inventory_allocations a
      JOIN order_items oi ON oi.id = a.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
        AND o.created_at BETWEEN $1 AND $2
    `, [todayStart, todayEnd]);
    const cogsToday = cogsTodayRes[0].total;
    const todayGrossProfit = revToday - cogsToday;

    const revMonthRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger
      WHERE type IN ('Customer Payment', 'Pre-order Advance', 'Pre-order Remaining Payment')
        AND status = 'Completed'
        AND date BETWEEN $1 AND $2
    `, [monthStart, todayEnd]);
    const revMonth = revMonthRes[0].total;

    const cogsMonthRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(a.quantity * a.purchase_price), 0)::float as total
      FROM order_inventory_allocations a
      JOIN order_items oi ON oi.id = a.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
        AND o.created_at BETWEEN $1 AND $2
    `, [monthStart, todayEnd]);
    const cogsMonth = cogsMonthRes[0].total;
    const monthlyGrossProfit = revMonth - cogsMonth;

    const marginRes = await this.dataSource.query(`
      WITH variant_costs AS (
        SELECT pv.id, pv.selling_price, COALESCE(AVG(ib.purchase_price), 0.00) as avg_cost
        FROM product_variants pv
        LEFT JOIN inventory_batches ib ON ib.variant_id = pv.id AND ib.status != 'Archived'
        WHERE pv.deleted_at IS NULL
        GROUP BY pv.id
      )
      SELECT COALESCE(AVG((selling_price - avg_cost) / selling_price) * 100, 0.00)::float as avg_margin
      FROM variant_costs
      WHERE selling_price > 0 AND avg_cost > 0;
    `);
    const averageMargin = marginRes[0].avg_margin;

    return {
      availableInventory,
      incomingInventory,
      totalPurchaseOrders,
      totalInventoryValue,
      lowStockAlerts,
      preorderCount,
      productsWithoutSKU,
      productsWithoutPrice,
      pendingReceiptCount: receiptInsights[0].pendingReceiptCount,
      pendingReceiptBalance: receiptInsights[0].pendingReceiptBalance,
      voidedReceiptCount: receiptInsights[0].voidedReceiptCount,
      receiptStats: {
        totalReceiptsCount: receiptInsights[0].totalReceiptsCount,
        standardCount: receiptInsights[0].standardCount,
        poCount: receiptInsights[0].poCount,
        stockRevenue: receiptInsights[0].stockRevenue,
        poRevenue: receiptInsights[0].poRevenue,
        poPendingAmount: receiptInsights[0].pendingReceiptBalance,
        totalRevenue: receiptInsights[0].totalRevenue,
        avgReceiptValue: receiptInsights[0].avgReceiptValue,
        thisMonthRevenue: receiptInsights[0].thisMonthRevenue,
        lastMonthRevenue: receiptInsights[0].lastMonthRevenue,
        monthGrowthPct: receiptInsights[0].lastMonthRevenue > 0
          ? Number((((receiptInsights[0].thisMonthRevenue - receiptInsights[0].lastMonthRevenue) / receiptInsights[0].lastMonthRevenue) * 100).toFixed(1))
          : receiptInsights[0].thisMonthRevenue > 0 ? 100 : 0,
        thisWeekRevenue: receiptInsights[0].thisWeekRevenue,
        lastWeekRevenue: receiptInsights[0].lastWeekRevenue,
        weekGrowthPct: receiptInsights[0].lastWeekRevenue > 0
          ? Number((((receiptInsights[0].thisWeekRevenue - receiptInsights[0].lastWeekRevenue) / receiptInsights[0].lastWeekRevenue) * 100).toFixed(1))
          : receiptInsights[0].thisWeekRevenue > 0 ? 100 : 0
      },
      receiptCharts: {
        daily: dailyReceiptChart,
        weekly: weeklyReceiptChart,
        monthly: monthlyReceiptChart
      },
      failedReceiptJobs: failedReceiptJobs[0].total,
      overduePurchaseOrders: overduePurchases[0].total,
      todayGrossProfit,
      monthlyGrossProfit,
      averageMargin
    };
  }

  async getInventoryVariantDetails(variantId: string) {
    // 1. Fetch variant and product summary
    const summaryRes = await this.dataSource.query(`
      SELECT 
        pv.id,
        p.sku,
        ct.display_name as "casing",
        pv.selling_price as "sellingPrice",
        p.model_name as "productName",
        COALESCE(SUM(ib.quantity_available), 0)::INT as "availableStock",
        COALESCE(SUM(ib.quantity_reserved), 0)::INT as "reservedStock",
        COALESCE(SUM(ib.quantity_sold), 0)::INT as "soldStock",
        COALESCE(SUM(ib.quantity_damaged), 0)::INT as "damagedStock",
        COALESCE(SUM(ib.quantity_returned), 0)::INT as "returnedStock",
        COALESCE(AVG(ib.purchase_price), 0.00)::NUMERIC(12,2) as "averagePurchaseCost",
        COALESCE(SUM(ib.quantity_available * ib.purchase_price), 0.00)::NUMERIC(12,2) as "inventoryValue"
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN casing_types ct ON ct.id = pv.casing_type_id
      LEFT JOIN inventory_batches ib ON ib.variant_id = pv.id AND ib.status != 'Archived'
      WHERE pv.id = $1
      GROUP BY pv.id, p.model_name, ct.display_name;
    `, [variantId]);

    if (summaryRes.length === 0) {
      throw new Error("Variant not found");
    }

    const summary = summaryRes[0];
    summary.averagePurchaseCost = Number(summary.averagePurchaseCost || 0);
    summary.sellingPrice = Number(summary.sellingPrice || 0);
    summary.inventoryValue = Number(summary.inventoryValue || 0);
    summary.availableStock = Number(summary.availableStock || 0);
    summary.reservedStock = Number(summary.reservedStock || 0);
    summary.soldStock = Number(summary.soldStock || 0);
    summary.damagedStock = Number(summary.damagedStock || 0);
    summary.returnedStock = Number(summary.returnedStock || 0);

    // Calculate margins
    if (summary.sellingPrice > 0) {
      summary.marginPercent = ((summary.sellingPrice - summary.averagePurchaseCost) / summary.sellingPrice) * 100;
    } else {
      summary.marginPercent = 0.00;
    }

    // Calculate incomingStock
    const incomingStockRes = await this.dataSource.query(`
      SELECT COALESCE(GREATEST(0, 
        (
          SELECT SUM(spi.quantity)
          FROM supplier_purchase_items spi
          JOIN supplier_purchases sp ON sp.id = spi.supplier_purchase_id
          WHERE spi.variant_id = $1
            AND sp.status NOT IN ('Draft', 'Cancelled', 'Completed')
        ) - COALESCE(
          (
            SELECT SUM(ib_rec.quantity_received)
            FROM inventory_batches ib_rec
            JOIN supplier_purchases sp_rec ON sp_rec.id = ib_rec.supplier_purchase_id
            WHERE ib_rec.variant_id = $1
              AND sp_rec.status NOT IN ('Draft', 'Cancelled', 'Completed')
              AND ib_rec.status != 'Archived'
          ), 0
        )
      ), 0)::int as total;
    `, [variantId]);
    summary.incomingStock = incomingStockRes[0].total;
    summary.totalStock = summary.availableStock + summary.reservedStock + summary.soldStock + summary.damagedStock + summary.returnedStock;

    // 2. Fetch active batches
    const batches = await this.dataSource.query(`
      SELECT 
        ib.id,
        ib.received_at,
        ib.purchase_price,
        ib.quantity_received,
        ib.quantity_available,
        s.name as "supplierName",
        spr.receipt_number as "receiptNumber"
      FROM inventory_batches ib
      LEFT JOIN suppliers s ON s.id = ib.supplier_id
      LEFT JOIN supplier_purchase_receipts spr ON spr.id = ib.purchase_receipt_id
      WHERE ib.variant_id = $1 AND ib.status != 'Archived'
      ORDER BY ib.received_at DESC;
    `, [variantId]);

    // 3. Fetch append-only ledger logs
    const ledger = await this.dataSource.query(`
      SELECT 
        il.id,
        il.created_at,
        il.type,
        il.quantity_changed,
        il.purchase_price,
        il.performed_by,
        il.reason,
        il.order_id as "orderId"
      FROM inventory_ledger il
      WHERE il.variant_id = $1
      ORDER BY il.created_at DESC;
    `, [variantId]);

    // 4. Fetch active reservations (from order_items of pending/confirmed orders)
    const reservations = await this.dataSource.query(`
      SELECT 
        oi.id,
        oi.qty as "quantity",
        u.email as "customerEmail",
        o.status,
        o.created_at + INTERVAL '24 hours' as "expires_at"
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN users u ON u.id = o.user_id
      WHERE oi.variant_id = $1
        AND o.status IN ('Pending', 'Verification Pending', 'Confirmed', 'Reserved')
      ORDER BY o.created_at DESC;
    `, [variantId]);

    // 5. Fetch allocations
    const allocations = await this.dataSource.query(`
      SELECT 
        a.id,
        a.quantity,
        a.purchase_price,
        oi.price_at_purchase as "selling_price",
        o.id as "orderId"
      FROM order_inventory_allocations a
      JOIN order_items oi ON oi.id = a.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.variant_id = $1
      ORDER BY o.created_at DESC;
    `, [variantId]);

    // 6. Fetch purchases
    const purchases = await this.dataSource.query(`
      SELECT 
        spi.id,
        spi.quantity,
        spi.purchase_price,
        sp.purchase_date as "purchaseDate",
        sp.status as "purchaseStatus",
        s.name as "supplierName"
      FROM supplier_purchase_items spi
      JOIN supplier_purchases sp ON sp.id = spi.supplier_purchase_id
      LEFT JOIN suppliers s ON s.id = sp.supplier_id
      WHERE spi.variant_id = $1
      ORDER BY sp.purchase_date DESC;
    `, [variantId]);

    return {
      summary,
      batches,
      ledger,
      reservations,
      allocations,
      purchases
    };
  }

  async getFinanceMetrics(timeRange = 'Lifetime', cashAccountId?: string) {
    const { start, end } = this.getDateFilter(timeRange);
    const prev = this.getPreviousPeriod(timeRange);

    const getMetricsForPeriod = async (s: Date, e: Date) => {
      let filterAcc = "";
      const params: any[] = [s, e];
      if (cashAccountId && cashAccountId !== 'all') {
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

    // Today's Revenue and COGS
    const revTodayRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger
      WHERE type IN ('Customer Payment', 'Pre-order Advance', 'Pre-order Remaining Payment')
        AND status = 'Completed'
        AND date BETWEEN $1 AND $2
    `, [todayStart, todayEnd]);
    const revToday = revTodayRes[0].total;

    const cogsTodayRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(a.quantity * a.purchase_price), 0)::float as total
      FROM order_inventory_allocations a
      JOIN order_items oi ON oi.id = a.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
        AND o.created_at BETWEEN $1 AND $2
    `, [todayStart, todayEnd]);
    const cogsToday = cogsTodayRes[0].total;
    const todayGrossProfit = revToday - cogsToday;

    // Monthly Revenue and COGS
    const revMonthRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(amount), 0)::float as total FROM cash_ledger
      WHERE type IN ('Customer Payment', 'Pre-order Advance', 'Pre-order Remaining Payment')
        AND status = 'Completed'
        AND date BETWEEN $1 AND $2
    `, [monthStart, todayEnd]);
    const revMonth = revMonthRes[0].total;

    const cogsMonthRes = await this.dataSource.query(`
      SELECT COALESCE(SUM(a.quantity * a.purchase_price), 0)::float as total
      FROM order_inventory_allocations a
      JOIN order_items oi ON oi.id = a.order_item_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
        AND o.created_at BETWEEN $1 AND $2
    `, [monthStart, todayEnd]);
    const cogsMonth = cogsMonthRes[0].total;
    const monthlyGrossProfit = revMonth - cogsMonth;

    // Average Margin across variants
    const marginRes = await this.dataSource.query(`
      WITH variant_costs AS (
        SELECT pv.id, pv.selling_price, COALESCE(AVG(ib.purchase_price), 0.00) as avg_cost
        FROM product_variants pv
        LEFT JOIN inventory_batches ib ON ib.variant_id = pv.id AND ib.status != 'Archived'
        WHERE pv.deleted_at IS NULL
        GROUP BY pv.id
      )
      SELECT COALESCE(AVG((selling_price - avg_cost) / selling_price) * 100, 0.00)::float as avg_margin
      FROM variant_costs
      WHERE selling_price > 0 AND avg_cost > 0;
    `);
    const averageMargin = marginRes[0].avg_margin;

    return {
      ...currentMetrics,
      profit: currentMetrics.netProfit,
      pendingPayments,
      inventoryValue: inventoryAssetValue,
      currentCashBalance,
      todayGrossProfit,
      monthlyGrossProfit,
      averageMargin,
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

  async createSystemNotification(title: string, message: string, type: string = 'info', orderId: string | null = null, queryRunner?: QueryRunner) {
    const executor = queryRunner || this.dataSource;
    await executor.query(`
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
    const cleanInstagram = String(instagram || '').trim().replace(/^@/, '');
    const cleanAddress = String(address || '').trim();
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
    `, [fullName || '', cleanPhone, cleanInstagram, cleanAddress, emailClean, city || 'Unknown']);
    return custRes[0];
  }

  // ── SETTINGS Endpoints ─────────────────────────────────────────────
  async getGlobalSettings() {
    const rows = await this.dataSource.query("SELECT value FROM global_settings WHERE key = 'app_settings';");
    const defaultSettings = { 
      showPrices: true,
      showSoldOutProducts: true,
      instagramUrl: 'https://www.instagram.com/garagekingsindia/',
      companyUpiId: 'garagekings@upi',
      upiQrImage: '/upi-qr.png',
      partnerNames: ['Harshal', 'Anutosh', 'Sanchit', 'Anish'],
      splits: { 'Harshal': 25, 'Anutosh': 25, 'Sanchit': 25, 'Anish': 25 },
      lowStockThreshold: 3,
      reservationDuration: 15,
      shippingConfig: {
        defaultFee: 200,
        freeShippingThreshold: null,
        regions: [{ code: 'IN', flatRate: 200 }]
      }
    };
    if (rows.length === 0) return defaultSettings;
    return {
      ...defaultSettings,
      ...rows[0].value
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
    localCache.del('public_product_page_settings');
    localCache.del('public_homepage_products');
    localCache.delByPrefix('product_');
    
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
    variantId: string,
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

    // Product SKU is the catalogue identifier; variants only identify casing/inventory choices.
    const varRows = await queryRunner.query(`
      SELECT p.sku, pv.product_id
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.id = $1;
    `, [variantId]);
    const sku = varRows[0]?.sku || `SKU-MIG-${Date.now()}`;
    const parentProductId = varRows[0]?.product_id;

    // Insert batch
    const batchRes = await queryRunner.query(`
      INSERT INTO inventory_batches (variant_id, supplier_id, supplier_purchase_id, purchase_receipt_id, sku, purchase_price, quantity_received, quantity_available, status, received_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'Open', NOW())
      RETURNING id;
    `, [variantId, distId, supplierPurchaseId || null, purchaseReceiptId || null, sku, Number(purchasePrice), Number(quantity)]);
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
      INSERT INTO inventory_ledger (variant_id, batch_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
      VALUES ($1, $2, 'RECEIVE', $3, $4, $5, $6, $7);
    `, [variantId, batchId, Number(quantity), Number(purchasePrice), Number(sellingPrice), `Received batch of ${quantity} units from ${distName}`, creatorEmail]);

    // Update variant stock and price
    await queryRunner.query(`
      UPDATE product_variants 
      SET total_stock = total_stock + $1,
          selling_price = $2,
          updated_at = NOW() 
      WHERE id = $3;
    `, [Number(quantity), Number(sellingPrice), variantId]);

    // Update products cache
    if (parentProductId) {
      await queryRunner.query(`
        UPDATE products 
        SET total_stock = total_stock + $1,
            purchase_price = $2,
            selling_price = $3,
            base_price = $3,
            updated_at = NOW() 
        WHERE id = $4;
      `, [Number(quantity), Number(purchasePrice), Number(sellingPrice), parentProductId]);

      // Update legacy inventory cache
      await queryRunner.query(`
        INSERT INTO inventory (product_id, quantity_available)
        VALUES ($1, $2)
        ON CONFLICT (product_id) DO UPDATE SET quantity_available = inventory.quantity_available + $2;
      `, [parentProductId, Number(quantity)]);
    }

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
        INSERT INTO inventory_ledger (variant_id, batch_id, order_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
        VALUES ($1, $2, $3, 'RESERVE', $4, $5, $6, $7, $8);
      `, [variantId, batchId, po.orderId, -allocQty, Number(purchasePrice), Number(sellingPrice), `Allocated pre-order for order item ${po.orderItemId}`, 'System/PreorderQueue']);

      // Update batch
      await queryRunner.query(`
        UPDATE inventory_batches
        SET quantity_available = quantity_available - $1,
            quantity_reserved = quantity_reserved + $1,
            status = CASE WHEN quantity_available - $1 = 0 THEN 'Fully Consumed'::VARCHAR ELSE 'Partially Used'::VARCHAR END,
            updated_at = NOW()
        WHERE id = $2;
      `, [allocQty, batchId]);

      // Update variant locked stock cache
      await queryRunner.query(`
        UPDATE product_variants
        SET locked_stock = locked_stock + $1,
            updated_at = NOW()
        WHERE id = $2;
      `, [allocQty, variantId]);

      // Update caches: deduct available and add to reserved
      if (parentProductId) {
        await queryRunner.query(`
          UPDATE products
          SET locked_stock = locked_stock + $1,
              updated_at = NOW()
          WHERE id = $2;
        `, [allocQty, parentProductId]);

        await queryRunner.query(`
          UPDATE inventory
          SET quantity_available = quantity_available - $1,
              quantity_reserved = quantity_reserved + $1,
              updated_at = NOW()
          WHERE product_id = $2;
        `, [allocQty, parentProductId]);
      }

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

  async updateInventoryBatch(batchId: string, dto: { purchasePrice?: number; quantityAvailable?: number; quantityReceived?: number; supplierId?: string }, updaterEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const batchRes = await queryRunner.query("SELECT * FROM inventory_batches WHERE id = $1 FOR UPDATE;", [batchId]);
      if (batchRes.length === 0) throw new Error("Batch not found");
      const oldBatch = batchRes[0];

      const purchasePrice = dto.purchasePrice !== undefined ? Number(dto.purchasePrice) : Number(oldBatch.purchase_price);
      const quantityAvailable = dto.quantityAvailable !== undefined ? Number(dto.quantityAvailable) : Number(oldBatch.quantity_available);
      const quantityReceived = dto.quantityReceived !== undefined ? Number(dto.quantityReceived) : Number(oldBatch.quantity_received);
      const supplierId = dto.supplierId !== undefined ? dto.supplierId : oldBatch.supplier_id;

      await queryRunner.query(`
        UPDATE inventory_batches
        SET purchase_price = $1,
            quantity_available = $2,
            quantity_received = $3,
            supplier_id = $4,
            updated_at = NOW()
        WHERE id = $5;
      `, [purchasePrice, quantityAvailable, quantityReceived, supplierId, batchId]);

      // Calculate quantity diff for ledger/cache adjustment
      const diff = quantityAvailable - Number(oldBatch.quantity_available);
      if (diff !== 0) {
        await queryRunner.query(`
          INSERT INTO inventory_ledger (variant_id, batch_id, type, quantity_changed, purchase_price, reason, performed_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7);
        `, [
          oldBatch.variant_id,
          batchId,
          diff > 0 ? 'ADJUST_ADD' : 'ADJUST_REMOVE',
          diff,
          purchasePrice,
          `Batch edit manual adjustment from ${oldBatch.quantity_available} to ${quantityAvailable}`,
          updaterEmail
        ]);

        // Fetch product ID from product_variants
        const varRes = await queryRunner.query("SELECT product_id FROM product_variants WHERE id = $1;", [oldBatch.variant_id]);
        if (varRes.length > 0) {
          const productId = varRes[0].product_id;
          // Update cache products
          await queryRunner.query(`
            UPDATE products
            SET total_stock = total_stock + $1,
                updated_at = NOW()
            WHERE id = $2;
          `, [diff, productId]);

          // Update legacy inventory
          await queryRunner.query(`
            UPDATE inventory
            SET quantity_available = quantity_available + $1,
                updated_at = NOW()
            WHERE product_id = $2;
          `, [diff, productId]);
        }
      }

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      await this.writeAuditLog(
        'UPDATE_BATCH',
        'inventory_batches',
        batchId,
        updaterEmail,
        ipAddress,
        oldBatch,
        { purchasePrice, quantityAvailable, quantityReceived, supplierId }
      );

      return { success: true };
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
    
    // Map frontend adjustment types to backend types
    let resolvedType = type;
    if (type === 'Adjusted') {
      resolvedType = change > 0 ? 'ADJUST_ADD' : 'ADJUST_REMOVE';
    } else if (type === 'Returned') {
      resolvedType = 'ADJUST_ADD';
    } else if (type === 'Damaged') {
      resolvedType = 'MARK_DAMAGED';
    }

    const allowedTypes = ['ADJUST_ADD', 'ADJUST_REMOVE', 'MARK_DAMAGED'];
    if (!allowedTypes.includes(resolvedType)) {
      throw new Error(`Adjustment type must resolve to one of: ${allowedTypes.join(', ')}`);
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

      const changeAbs = Math.abs(change);

      if (resolvedType === 'ADJUST_ADD') {
        newAvail += changeAbs;
      } else if (resolvedType === 'ADJUST_REMOVE') {
        if (newAvail < changeAbs) throw new Error('Insufficient available stock in batch to remove');
        newAvail -= changeAbs;
      } else if (resolvedType === 'MARK_DAMAGED') {
        if (newAvail < changeAbs) throw new Error('Insufficient available stock in batch to mark as damaged');
        newAvail -= changeAbs;
        newDamaged += changeAbs;
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

      // 2. Insert ledger movement entry with product_id and variant_id
      const ledgerQtyChange = (resolvedType === 'ADJUST_ADD') ? changeAbs : -changeAbs;
      await queryRunner.query(`
        INSERT INTO inventory_ledger (product_id, variant_id, batch_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
      `, [b.product_id, b.variant_id, batchId, resolvedType, ledgerQtyChange, Number(b.purchase_price), Number(b.selling_price), reason || `Manual adjustment type ${type}`, adminEmail]);

      // 3. Post matching financial write-off to the cash_ledger if stock is written off
      if (resolvedType === 'ADJUST_REMOVE' || resolvedType === 'MARK_DAMAGED') {
        const financialLoss = changeAbs * Number(b.purchase_price);
        if (financialLoss > 0) {
          const cashLedgerType = (resolvedType === 'MARK_DAMAGED') ? 'Inventory Damage' : 'Inventory Write-off';
          await queryRunner.query(`
            INSERT INTO cash_ledger (amount, type, status, source_type, source_id, reason, created_by, date)
            VALUES ($1, $2, 'Completed', 'Inventory Batch', $3, $4, $5, CURRENT_DATE);
          `, [
            -financialLoss,
            cashLedgerType,
            batchId,
            `Write-off of ${changeAbs} unit(s) due to: ${reason || 'Manual Adjustment'}`,
            adminEmail
          ]);
        }
      }

      // 4. Update products and inventory caches
      const diffAvailable = ledgerQtyChange;
      const diffDamaged = (resolvedType === 'MARK_DAMAGED') ? changeAbs : 0;

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
          pv.product_id,
          SUM(ib.quantity_available)::int as sum_available,
          SUM(ib.quantity_reserved)::int as sum_reserved,
          SUM(ib.quantity_sold)::int as sum_sold,
          SUM(ib.quantity_returned)::int as sum_returned,
          SUM(ib.quantity_damaged)::int as sum_damaged
        FROM inventory_batches ib
        JOIN product_variants pv ON pv.id = ib.variant_id
        GROUP BY pv.product_id
      `);
      
      for (const bs of batchSums) {
        if (!bs.product_id) continue;
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
      
      const historicalBatchesRes = await this.dataSource.query(`
        SELECT DISTINCT batch_id FROM inventory_ledger 
        WHERE reason LIKE '%Historical%' AND batch_id IS NOT NULL;
      `);
      const historicalBatchIds = new Set(historicalBatchesRes.map(row => row.batch_id));
      
      const allBatchesRes = await this.dataSource.query(`
        SELECT id, quantity_received, quantity_available, quantity_reserved, quantity_sold, quantity_returned, quantity_damaged 
        FROM inventory_batches;
      `);
      const batchMap = {};
      allBatchesRes.forEach(b => batchMap[b.id] = b);
      
      for (const ls of ledgerSums) {
        if (historicalBatchIds.has(ls.batch_id)) {
          continue;
        }
        
        const b = batchMap[ls.batch_id];
        if (!b) {
          mismatches.push(`Batch ID ${ls.batch_id}: Batch missing but exists in ledger.`);
          continue;
        }

        if (Number(b.quantity_available) + Number(b.quantity_reserved) !== ls.total_change) {
          mismatches.push(`Batch ID ${ls.batch_id}: Ledger mismatch. Batch Available:${b.quantity_available} (Res:${b.quantity_reserved}) vs Ledger Total Change:${ls.total_change}.`);
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

  async reconcileVariantInventory(variantId: string, actualCount: number, reason: string, adminEmail: string, ipAddress: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Lock the variant FOR UPDATE
      const varRows = await queryRunner.query(`
        SELECT id, product_id, total_stock 
        FROM product_variants 
        WHERE id = $1 AND deleted_at IS NULL 
        FOR UPDATE;
      `, [variantId]);

      if (varRows.length === 0) {
        throw new BadRequestException("Target variant does not exist or has been archived.");
      }

      const pv = varRows[0];
      const productId = pv.product_id;

      // 2. Lock and fetch batches FOR UPDATE
      const batches = await queryRunner.query(`
        SELECT id, purchase_price, quantity_available, quantity_reserved 
        FROM inventory_batches 
        WHERE variant_id = $1 
        FOR UPDATE;
      `, [variantId]);

      const systemCount = batches.reduce((sum, b) => sum + Number(b.quantity_available), 0);
      const variance = actualCount - systemCount;

      if (variance > 0) {
        // Find latest batch to allocate extra stock
        const latestBatchRes = await queryRunner.query(`
          SELECT id, purchase_price 
          FROM inventory_batches 
          WHERE variant_id = $1 
          ORDER BY received_at DESC, id DESC 
          LIMIT 1;
        `, [variantId]);

        let targetBatchId: string;
        let purchasePrice = 0.00;

        if (latestBatchRes.length > 0) {
          targetBatchId = latestBatchRes[0].id;
          purchasePrice = Number(latestBatchRes[0].purchase_price);
          await queryRunner.query(`
            UPDATE inventory_batches 
            SET quantity_available = quantity_available + $1, 
                updated_at = NOW() 
            WHERE id = $2;
          `, [variance, targetBatchId]);
        } else {
          // Create default adjustment batch
          const newBatchRes = await queryRunner.query(`
            INSERT INTO inventory_batches (variant_id, quantity_received, quantity_available, quantity_reserved, quantity_sold, quantity_returned, quantity_damaged, purchase_price, received_at, status)
            VALUES ($1, $2, $2, 0, 0, 0, 0, 0.00, NOW(), 'Active')
            RETURNING id;
          `, [variantId, variance]);
          targetBatchId = newBatchRes[0].id;
        }

        // Increment variant total_stock
        await queryRunner.query(`
          UPDATE product_variants 
          SET total_stock = total_stock + $1, 
              updated_at = NOW() 
          WHERE id = $2;
        `, [variance, variantId]);

        // Insert ledger ADJUST_ADD
        await queryRunner.query(`
          INSERT INTO inventory_ledger (variant_id, batch_id, type, quantity_changed, purchase_price, reason, performed_by)
          VALUES ($1, $2, 'ADJUST_ADD', $3, $4, $5, $6);
        `, [variantId, targetBatchId, variance, purchasePrice, reason || 'Cycle Count Stock Increase', adminEmail]);

      } else if (variance < 0) {
        // Deplete from active batches in FIFO order
        const activeBatches = await queryRunner.query(`
          SELECT id, purchase_price, quantity_available 
          FROM inventory_batches 
          WHERE variant_id = $1 AND quantity_available > 0 
          ORDER BY received_at ASC 
          FOR UPDATE;
        `, [variantId]);

        let remainingToReduce = Math.abs(variance);
        for (const b of activeBatches) {
          if (remainingToReduce <= 0) break;
          const reduceQty = Math.min(remainingToReduce, Number(b.quantity_available));
          
          await queryRunner.query(`
            UPDATE inventory_batches 
            SET quantity_available = quantity_available - $1, 
                status = CASE WHEN quantity_available - $1 = 0 THEN 'Fully Consumed'::VARCHAR ELSE status END, 
                updated_at = NOW() 
            WHERE id = $2;
          `, [reduceQty, b.id]);

          // Insert ledger ADJUST_REMOVE
          await queryRunner.query(`
            INSERT INTO inventory_ledger (variant_id, batch_id, type, quantity_changed, purchase_price, reason, performed_by)
            VALUES ($1, $2, 'ADJUST_REMOVE', $3, $4, $5, $6);
          `, [variantId, b.id, -reduceQty, Number(b.purchase_price), reason || 'Cycle Count Shrinkage Depletion', adminEmail]);

          remainingToReduce -= reduceQty;
        }

        // Decrement variant total_stock
        await queryRunner.query(`
          UPDATE product_variants 
          SET total_stock = GREATEST(0, total_stock - $1), 
              updated_at = NOW() 
          WHERE id = $2;
        `, [Math.abs(variance), variantId]);
      }

      // Explicitly set variant total_stock to match reconciled count
      await queryRunner.query(`
        UPDATE product_variants 
        SET total_stock = $1, 
            updated_at = NOW() 
        WHERE id = $2;
      `, [actualCount, variantId]);

      // Stock is owned by the product in GarageKings. Variants and batches are
      // retained for inventory history, but legacy sibling variants must not
      // overwrite the quantity explicitly submitted for the product.
      await queryRunner.query(`
        UPDATE products p
        SET total_stock = $2,
            stock = $2,
            available_stock = $2,
            updated_at = NOW()
        WHERE p.id = $1;
      `, [productId, actualCount]);

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');
      localCache.del(`product_${productId}_true`);
      localCache.del(`product_${productId}_false`);

      await this.writeAuditLog(
        'RECONCILE_CYCLE_COUNT',
        'product_variants',
        variantId,
        adminEmail,
        ipAddress,
        { systemCount },
        { actualCount, variance, reason }
      );

      return { success: true, systemCount, actualCount, variance };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
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

  // ==========================================
  //      MASTER DATA LOOKUP RESOLVERS
  // ==========================================

  // Brands
  async getCatalogLookups() {
    const [brands, scales, series, casingTypes, categories, tags] = await Promise.all([
      this.dataSource.query("SELECT name FROM brands WHERE deleted_at IS NULL AND status = 'Active' ORDER BY display_order ASC, name ASC;"),
      this.dataSource.query("SELECT name FROM scales WHERE deleted_at IS NULL AND status = 'Active' ORDER BY display_order ASC, name ASC;"),
      this.dataSource.query("SELECT name FROM series WHERE deleted_at IS NULL AND status = 'Active' ORDER BY display_order ASC, name ASC;"),
      this.dataSource.query("SELECT name FROM casing_types ORDER BY name ASC;"),
      this.dataSource.query("SELECT name FROM categories ORDER BY display_order ASC, name ASC;"),
      this.dataSource.query("SELECT name FROM tags ORDER BY name ASC;"),
    ]);
    const names = (rows: any[]) => rows.map(row => String(row.name || '').trim()).filter(Boolean);
    return {
      brands: names(brands),
      scales: names(scales),
      series: names(series),
      casingTypes: names(casingTypes),
      categories: names(categories),
      tags: names(tags),
    };
  }

  private async validateCatalogReferences(car: any) {
    const lookups = await this.getCatalogLookups();
    const assertValue = (label: string, value: any, options: string[]) => {
      if (value === undefined || value === null || String(value).trim() === '') return;
      const normalized = String(value).trim().toLocaleLowerCase();
      if (!options.some(option => option.toLocaleLowerCase() === normalized)) {
        throw new BadRequestException(`${label} "${String(value).trim()}" is not configured in Catalog Lookup Settings.`);
      }
    };
    assertValue('Brand', car.brand, lookups.brands);
    assertValue('Scale', car.scale, lookups.scales);
    assertValue('Series', car.series, lookups.series);
    assertValue('Packaging', car.casing ?? car.casingType, lookups.casingTypes);
    assertValue('Category', car.category, lookups.categories);
    const mainTag = car.tag ?? car.grade ?? car.lane;
    if (mainTag && String(mainTag).toLocaleLowerCase() !== 'none') assertValue('Rarity', mainTag, lookups.tags);
    const submittedTags = Array.isArray(car.tags) ? car.tags : (Array.isArray(car.subtags) ? car.subtags : []);
    submittedTags.forEach((tag: any) => assertValue('Tag', tag, lookups.tags));
  }

  async getBrands(adminMode = false) {
    if (adminMode) {
      return this.dataSource.query("SELECT * FROM brands ORDER BY display_order ASC, name ASC;");
    }
    const settings = await this.getGlobalSettings();
    const stockVisibility = settings.showSoldOutProducts === false
      ? `AND COALESCE(p.available_stock, p.stock, p.total_stock, 0) > 0`
      : '';
    return this.dataSource.query(`
      SELECT b.id,
             b.name,
             b.slug,
             b.logo_url,
             (to_jsonb(b) ->> 'cover_image_url') AS cover_image_url,
             b.website,
             b.display_order,
             b.is_visible,
             b.status,
             b.accent_color,
             b.secondary_color,
             b.background_color,
             b.theme_variant,
             b.logo_treatment,
             b.kicker,
             b.headline,
             b.description,
             b.origin_label,
             b.style_label,
             COUNT(p.id)::int AS product_count
      FROM brands b
      LEFT JOIN products p
        ON LOWER(TRIM(p.brand)) = LOWER(TRIM(b.name))
       AND p.deleted_at IS NULL
       AND (p.status IN ('Published', 'Pre-Order', 'Active') OR p.status IS NULL)
       ${stockVisibility}
      WHERE b.deleted_at IS NULL
        AND b.is_visible = true
        AND b.status = 'Active'
      GROUP BY b.id
      ORDER BY b.display_order ASC, b.name ASC;
    `);
  }

  async createBrand(body: any) {
    const { name, logoUrl, coverImageUrl, website, displayOrder, isVisible, status, accentColor, secondaryColor, backgroundColor, themeVariant, logoTreatment, kicker, headline, description, originLabel, styleLabel } = body;
    const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const result = await this.dataSource.query(`
      INSERT INTO brands (name, slug, logo_url, cover_image_url, website, display_order, is_visible, status, accent_color, secondary_color, background_color, theme_variant, logo_treatment, kicker, headline, description, origin_label, style_label)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *;
    `, [name, slug, logoUrl || null, coverImageUrl || null, website || null, displayOrder || 0, isVisible !== false, status || 'Active', accentColor || '#C8AE7D', secondaryColor || '#F4F1EC', backgroundColor || '#080706', themeVariant || 'archive', logoTreatment || 'natural', kicker || null, headline || null, description || null, originLabel || null, styleLabel || null]);
    return result[0];
  }

  async updateBrand(id: string, body: any) {
    const { name, logoUrl, coverImageUrl, website, displayOrder, isVisible, status, accentColor, secondaryColor, backgroundColor, themeVariant, logoTreatment, kicker, headline, description, originLabel, styleLabel } = body;
    const slug = name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') : undefined;
    
    const fields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (name !== undefined) { fields.push(`name = $${paramIndex++}`, `slug = $${paramIndex++}`); params.push(name, slug); }
    if (logoUrl !== undefined) { fields.push(`logo_url = $${paramIndex++}`); params.push(logoUrl); }
    if (coverImageUrl !== undefined) { fields.push(`cover_image_url = $${paramIndex++}`); params.push(coverImageUrl); }
    if (website !== undefined) { fields.push(`website = $${paramIndex++}`); params.push(website); }
    if (displayOrder !== undefined) { fields.push(`display_order = $${paramIndex++}`); params.push(displayOrder); }
    if (isVisible !== undefined) { fields.push(`is_visible = $${paramIndex++}`); params.push(isVisible); }
    if (status !== undefined) { fields.push(`status = $${paramIndex++}`); params.push(status); }
    if (accentColor !== undefined) { fields.push(`accent_color = $${paramIndex++}`); params.push(accentColor); }
    if (secondaryColor !== undefined) { fields.push(`secondary_color = $${paramIndex++}`); params.push(secondaryColor); }
    if (backgroundColor !== undefined) { fields.push(`background_color = $${paramIndex++}`); params.push(backgroundColor); }
    if (themeVariant !== undefined) { fields.push(`theme_variant = $${paramIndex++}`); params.push(themeVariant); }
    if (logoTreatment !== undefined) { fields.push(`logo_treatment = $${paramIndex++}`); params.push(logoTreatment); }
    if (kicker !== undefined) { fields.push(`kicker = $${paramIndex++}`); params.push(kicker); }
    if (headline !== undefined) { fields.push(`headline = $${paramIndex++}`); params.push(headline); }
    if (description !== undefined) { fields.push(`description = $${paramIndex++}`); params.push(description); }
    if (originLabel !== undefined) { fields.push(`origin_label = $${paramIndex++}`); params.push(originLabel); }
    if (styleLabel !== undefined) { fields.push(`style_label = $${paramIndex++}`); params.push(styleLabel); }

    if (fields.length === 0) return { success: true };

    params.push(id);
    const query = `UPDATE brands SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *;`;
    const result = await this.dataSource.query(query, params);
    return result[0];
  }

  async archiveBrand(id: string) {
    await this.dataSource.query("UPDATE brands SET status = 'Archived', deleted_at = NOW() WHERE id = $1;", [id]);
    return { success: true };
  }

  // Manufacturers
  async getManufacturers(adminMode = false) {
    if (adminMode) {
      return this.dataSource.query("SELECT * FROM manufacturers ORDER BY display_order ASC, name ASC;");
    }
    return this.dataSource.query("SELECT * FROM manufacturers WHERE deleted_at IS NULL AND status = 'Active' ORDER BY display_order ASC, name ASC;");
  }

  async createManufacturer(body: any) {
    const { name, logoUrl, website, displayOrder, isVisible, status } = body;
    const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const result = await this.dataSource.query(`
      INSERT INTO manufacturers (name, slug, logo_url, website, display_order, is_visible, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `, [name, slug, logoUrl || null, website || null, displayOrder || 0, isVisible !== false, status || 'Active']);
    return result[0];
  }

  async updateManufacturer(id: string, body: any) {
    const { name, logoUrl, website, displayOrder, isVisible, status } = body;
    const slug = name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') : undefined;
    
    const fields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (name !== undefined) { fields.push(`name = $${paramIndex++}`, `slug = $${paramIndex++}`); params.push(name, slug); }
    if (logoUrl !== undefined) { fields.push(`logo_url = $${paramIndex++}`); params.push(logoUrl); }
    if (website !== undefined) { fields.push(`website = $${paramIndex++}`); params.push(website); }
    if (displayOrder !== undefined) { fields.push(`display_order = $${paramIndex++}`); params.push(displayOrder); }
    if (isVisible !== undefined) { fields.push(`is_visible = $${paramIndex++}`); params.push(isVisible); }
    if (status !== undefined) { fields.push(`status = $${paramIndex++}`); params.push(status); }

    if (fields.length === 0) return { success: true };

    params.push(id);
    const query = `UPDATE manufacturers SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *;`;
    const result = await this.dataSource.query(query, params);
    return result[0];
  }

  async archiveManufacturer(id: string) {
    await this.dataSource.query("UPDATE manufacturers SET status = 'Archived', deleted_at = NOW() WHERE id = $1;", [id]);
    return { success: true };
  }

  // Scales
  async getScales(adminMode = false) {
    if (adminMode) {
      return this.dataSource.query("SELECT * FROM scales ORDER BY display_order ASC, name ASC;");
    }
    return this.dataSource.query("SELECT * FROM scales WHERE deleted_at IS NULL AND status = 'Active' ORDER BY display_order ASC, name ASC;");
  }

  async createScale(body: any) {
    const { name, displayOrder, status } = body;
    const result = await this.dataSource.query(`
      INSERT INTO scales (name, display_order, status)
      VALUES ($1, $2, $3)
      RETURNING *;
    `, [name, displayOrder || 0, status || 'Active']);
    return result[0];
  }

  async updateScale(id: string, body: any) {
    const { name, displayOrder, status } = body;
    const fields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (name !== undefined) { fields.push(`name = $${paramIndex++}`); params.push(name); }
    if (displayOrder !== undefined) { fields.push(`display_order = $${paramIndex++}`); params.push(displayOrder); }
    if (status !== undefined) { fields.push(`status = $${paramIndex++}`); params.push(status); }

    if (fields.length === 0) return { success: true };

    params.push(id);
    const query = `UPDATE scales SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *;`;
    const result = await this.dataSource.query(query, params);
    return result[0];
  }

  async archiveScale(id: string) {
    await this.dataSource.query("UPDATE scales SET status = 'Archived', deleted_at = NOW() WHERE id = $1;", [id]);
    return { success: true };
  }

  // Series
  async getSeries(adminMode = false) {
    if (adminMode) {
      return this.dataSource.query("SELECT * FROM series ORDER BY display_order ASC, name ASC;");
    }
    return this.dataSource.query("SELECT * FROM series WHERE deleted_at IS NULL AND status = 'Active' ORDER BY display_order ASC, name ASC;");
  }

  async createSeries(body: any) {
    const { name, displayOrder, status } = body;
    const result = await this.dataSource.query(`
      INSERT INTO series (name, display_order, status)
      VALUES ($1, $2, $3)
      RETURNING *;
    `, [name, displayOrder || 0, status || 'Active']);
    return result[0];
  }

  async updateSeries(id: string, body: any) {
    const { name, displayOrder, status } = body;
    const fields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (name !== undefined) { fields.push(`name = $${paramIndex++}`); params.push(name); }
    if (displayOrder !== undefined) { fields.push(`display_order = $${paramIndex++}`); params.push(displayOrder); }
    if (status !== undefined) { fields.push(`status = $${paramIndex++}`); params.push(status); }

    if (fields.length === 0) return { success: true };

    params.push(id);
    const query = `UPDATE series SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *;`;
    const result = await this.dataSource.query(query, params);
    return result[0];
  }

  async archiveSeries(id: string) {
    await this.dataSource.query("UPDATE series SET status = 'Archived', deleted_at = NOW() WHERE id = $1;", [id]);
    return { success: true };
  }

  async addSupplierPurchaseAttachment(purchaseId: string, fileBuffer: Buffer, fileName: string, fileExtension: string, adminEmail: string) {
    const generatedName = `${crypto.randomUUID()}.${fileExtension}`;
    if (process.env.S3_PRIVATE_BUCKET) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_PRIVATE_BUCKET,
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

    if (process.env.S3_PRIVATE_BUCKET) {
      try {
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const res = await s3.send(new GetObjectCommand({
          Bucket: process.env.S3_PRIVATE_BUCKET,
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
