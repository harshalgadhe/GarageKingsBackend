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

    // ── 15-SECOND RESERVATION TIMER WORKER ─────────────────────────
    // Disabled reservation timer worker: Checkout is now first-come-first-served
    // setInterval(async () => {
    //   try {
    //     await this.expireActiveReservations();
    //   } catch (err) {
    //     console.error("[Worker Error] Failed executing reservation cleanup:", err);
    //   }
    // }, 15000);
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

    let queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.purchase_price as "purchasePrice", p.selling_price as "sellingPrice",
             p.total_stock as "totalStock", p.locked_stock as "lockedStock", p.sold_stock as "soldStock",
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.supplier, p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage", p.created_by as "createdBy", p.updated_by as "updatedBy",
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
  }) {
    const page = Math.max(1, Number(options.page || 1));
    const limit = Math.max(1, Math.min(100, Number(options.limit || 12)));
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.purchase_price as "purchasePrice", p.selling_price as "sellingPrice",
             p.total_stock as "totalStock", p.locked_stock as "lockedStock", p.sold_stock as "soldStock",
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.supplier, p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage", p.created_by as "createdBy", p.updated_by as "updatedBy",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             p.is_prebook as "isPrebook", p.prebook_deposit_amount as "prebookDepositAmount",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL AND p.status = 'Published'
    `;

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

  async getProduct(id: string) {
    const cacheKey = `product_${id}`;
    const cached = localCache.get(cacheKey);
    if (cached) return cached;

    const queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.purchase_price as "purchasePrice", p.selling_price as "sellingPrice",
             p.total_stock as "totalStock", p.locked_stock as "lockedStock", p.sold_stock as "soldStock",
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.supplier, p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage", p.created_by as "createdBy", p.updated_by as "updatedBy",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             p.is_prebook as "isPrebook", p.prebook_deposit_amount as "prebookDepositAmount",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL AND p.id = $1
      LIMIT 1;
    `;

    const rows = await this.dataSource.query(queryStr, [id]);
    if (rows.length === 0) return null;
    localCache.set(cacheKey, rows[0], 10); // Cache single item for 10 seconds
    return rows[0];
  }

  async addProduct(car: any, creatorEmail: string, ipAddress: string) {
    const sku = car.sku || `SKU-${Date.now()}`;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const prodRes = await queryRunner.query(`
        INSERT INTO products (sku, brand, model_name, series, scale, rarity_level, base_price, description, tags, category, purchase_price, selling_price, total_stock, supplier, arrival_date, release_date, status, show_on_homepage, created_by, max_qty_per_customer, is_prebook, prebook_deposit_amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
        Number(car.purchasePrice || 0),
        Number(car.price || 0),
        Number(car.totalStock || 10),
        car.supplier || '',
        car.arrivalDate || null,
        car.releaseDate || null,
        car.status || 'Published',
        car.showOnHomepage !== false,
        creatorEmail,
        car.maxQtyPerCustomer !== undefined && car.maxQtyPerCustomer !== null && car.maxQtyPerCustomer !== '' ? Number(car.maxQtyPerCustomer) : null,
        car.isPrebook === true,
        car.prebookDepositAmount !== undefined && car.prebookDepositAmount !== null && car.prebookDepositAmount !== '' ? Number(car.prebookDepositAmount) : null
      ]);

      const productId = prodRes[0].id;

      if (car.image) {
        await queryRunner.query(`
          INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
          VALUES ($1, $2, $3, $4, true);
        `, [productId, car.image, car.image, car.image]);
      }

      await queryRunner.query(`
        INSERT INTO inventory (product_id, quantity_available, quantity_reserved)
        VALUES ($1, $2, 0)
        ON CONFLICT (product_id) DO UPDATE SET quantity_available = $2;
      `, [productId, Number(car.totalStock || 10)]);

      // Low stock check trigger
      if (Number(car.totalStock || 10) <= 3) {
        await this.createSystemNotification(
          'Low Stock Alert',
          `Casting "${car.name}" has critical stock count: ${car.totalStock}`,
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
      await queryRunner.query(`
        UPDATE products 
        SET brand = $1, model_name = $2, series = $3, scale = $4, rarity_level = $5, base_price = $6, description = $7, tags = $8,
            category = $9, purchase_price = $10, selling_price = $11, total_stock = $12, supplier = $13,
            arrival_date = $14, release_date = $15, status = $16, show_on_homepage = $17, updated_by = $18, 
            max_qty_per_customer = $19, is_prebook = $20, prebook_deposit_amount = $21, updated_at = NOW()
        WHERE id = $22;
      `, [
        car.brand || 'MINI GT',
        car.name || 'Unknown Casting',
        car.series || '',
        car.scale || '1:64',
        car.lane || 'Standard Edition',
        Number(car.price || 0),
        car.description || '',
        car.tags || [],
        car.category || 'JDM',
        Number(car.purchasePrice || 0),
        Number(car.price || 0),
        Number(car.totalStock || 10),
        car.supplier || '',
        car.arrivalDate || null,
        car.releaseDate || null,
        car.status || 'Published',
        car.showOnHomepage !== false,
        updaterEmail,
        car.maxQtyPerCustomer !== undefined && car.maxQtyPerCustomer !== null && car.maxQtyPerCustomer !== '' ? Number(car.maxQtyPerCustomer) : null,
        car.isPrebook === true,
        car.prebookDepositAmount !== undefined && car.prebookDepositAmount !== null && car.prebookDepositAmount !== '' ? Number(car.prebookDepositAmount) : null,
        id
      ]);

      if (car.image) {
        await queryRunner.query(`DELETE FROM product_images WHERE product_id = $1;`, [id]);
        await queryRunner.query(`
          INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
          VALUES ($1, $2, $3, $4, true);
        `, [id, car.image, car.image, car.image]);
      }

      const available = Number(car.totalStock || 10) - Number(oldData.locked_stock || 0) - Number(oldData.sold_stock || 0);
      await queryRunner.query(`
        UPDATE inventory 
        SET quantity_available = $1, updated_at = NOW()
        WHERE product_id = $2;
      `, [available, id]);

      // Trigger low stock notifications
      if (available <= 3) {
        await this.createSystemNotification(
          'Low Stock Alert',
          `Casting "${car.name}" has critical stock count: ${available}`,
          'low_stock'
        );
      }

      await queryRunner.commitTransaction();
      localCache.del('products_list_true');
      localCache.del('products_list_false');

      // Log audit trace
      await this.writeAuditLog('UPDATE_PRODUCT', 'products', id, updaterEmail, ipAddress, oldData, car);

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
  async saveScreenshotReceipt(orderId: string, fileBuffer: Buffer, fileExtension: string, ipAddress: string) {
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
    const oldRes = await this.dataSource.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    if (oldRes.length === 0) {
      throw new Error("Order not found.");
    }
    if (oldRes[0].status === 'Confirmed') {
      return { success: true };
    }
    
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get order items
      const items = await queryRunner.query("SELECT product_id, qty FROM order_items WHERE order_id = $1", [orderId]);
      for (const item of items) {
        // Lock and check product stock
        const prodRows = await queryRunner.query(`
          SELECT id, model_name as name, total_stock, sold_stock, locked_stock
          FROM products 
          WHERE id = $1 AND deleted_at IS NULL 
          FOR UPDATE;
        `, [item.product_id]);

        if (prodRows.length === 0) {
          throw new Error("Target casting does not exist or has been archived.");
        }

        const p = prodRows[0];
        const available = Number(p.total_stock) - Number(p.locked_stock) - Number(p.sold_stock);
        if (available < Number(item.qty)) {
          throw new Error(`Cannot approve order. Casting "${p.name}" is sold out. Available: ${available}, requested: ${item.qty}.`);
        }

        // Increment sold_stock and release locked_stock if legacy active reservation existed
        await queryRunner.query(`
          UPDATE products 
          SET sold_stock = sold_stock + $1,
              locked_stock = GREATEST(0, locked_stock - $1),
              updated_at = NOW() 
          WHERE id = $2;
        `, [Number(item.qty), item.product_id]);
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
      }

      // If status transitioned to Cancelled, release stock
      if (fields.status === 'Cancelled' && old.status !== 'Cancelled') {
        const items = await queryRunner.query("SELECT product_id, qty FROM order_items WHERE order_id = $1", [orderId]);
        for (const item of items) {
          if (old.status === 'Confirmed' || old.status === 'Shipped' || old.status === 'Delivered') {
            await queryRunner.query(`
              UPDATE products 
              SET sold_stock = GREATEST(0, sold_stock - $1), updated_at = NOW()
              WHERE id = $2;
            `, [item.qty, item.product_id]);
          } else if (old.status === 'Reserved' || old.status === 'Verification Pending') {
            await queryRunner.query(`
              UPDATE products 
              SET locked_stock = GREATEST(0, locked_stock - $1), updated_at = NOW()
              WHERE id = $2;
            `, [item.qty, item.product_id]);
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

  async addExpense(exp: any, adminEmail: string, ipAddress: string) {
    const result = await this.dataSource.query(`
      INSERT INTO expenses (title, amount, category, paid_by, date, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id;
    `, [exp.title, Number(exp.amount), exp.category, exp.paidBy, exp.date, exp.notes || '']);
    
    await this.writeAuditLog(
      'CREATE_EXPENSE',
      'expenses',
      result[0].id,
      adminEmail,
      ipAddress,
      null,
      exp
    );

    return result[0];
  }

  async softDeleteExpense(id: string, adminEmail: string, ipAddress: string) {
    const old = await this.dataSource.query("SELECT * FROM expenses WHERE id = $1", [id]);
    await this.dataSource.query("UPDATE expenses SET deleted_at = NOW() WHERE id = $1", [id]);
    await this.writeAuditLog(
      'DELETE_EXPENSE',
      'expenses',
      id,
      adminEmail,
      ipAddress,
      old[0],
      { deleted: true }
    );
    return { success: true };
  }

  // ── FOUNDER SPLITS & FINANCE METRICS ────────────────────────────────
  async getSplits() {
    // 4 Founders
    const founders = ['Harshal', 'Anutosh', 'Sanchit', 'Anish'];
    const settings = await this.getGlobalSettings();
    const splits = settings.splits || {
      'Harshal': 25,
      'Anutosh': 25,
      'Sanchit': 25,
      'Anish': 25
    };

    // Calculate total paid by each founder
    const expRows = await this.dataSource.query(`
      SELECT paid_by, SUM(amount) as total 
      FROM expenses 
      WHERE deleted_at IS NULL 
      GROUP BY paid_by;
    `);

    const paidMap = {};
    founders.forEach(f => paidMap[f] = 0);
    expRows.forEach(row => {
      if (founders.includes(row.paid_by)) {
        paidMap[row.paid_by] = Number(row.total);
      }
    });

    // Total expenses
    const totalExp = Object.values(paidMap).reduce((a: number, b: number) => a + b, 0) as number;

    // What each owner should have paid based on splits percentage
    const targetOwed = {};
    founders.forEach(f => {
      const pct = splits[f] || 25;
      targetOwed[f] = totalExp * (pct / 100);
    });

    // Calculate settlement adjustments
    const settlements = await this.dataSource.query("SELECT * FROM split_settlements ORDER BY date DESC;");
    const sentMap = {};
    const recMap = {};
    founders.forEach(f => {
      sentMap[f] = 0;
      recMap[f] = 0;
    });

    settlements.forEach(s => {
      if (founders.includes(s.from_founder)) sentMap[s.from_founder] += Number(s.amount);
      if (founders.includes(s.to_founder)) recMap[s.to_founder] += Number(s.amount);
    });

    // Final balance calculation
    // Balance = (Actual Paid + Settlements Received) - (Target Owed + Settlements Sent)
    // Positive balance = owed money; Negative balance = owes money
    const balances = {};
    founders.forEach(f => {
      balances[f] = (paidMap[f] + recMap[f]) - (targetOwed[f] + sentMap[f]);
    });

    // Build ledger transfers recommendations
    const owesWho = [];
    const debtors = founders.filter(f => balances[f] < -0.01).sort((a,b) => balances[a] - balances[b]);
    const creditors = founders.filter(f => balances[f] > 0.01).sort((a,b) => balances[b] - balances[a]);

    let dIdx = 0;
    let cIdx = 0;
    
    // Copy balances to mutate
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

  async addSettlement(from: string, to: string, amount: number, notes: string, date: string) {
    await this.dataSource.query(`
      INSERT INTO split_settlements (from_founder, to_founder, amount, notes, date)
      VALUES ($1, $2, $3, $4, $5);
    `, [from, to, amount, notes || '', date]);
    return { success: true };
  }

  async getFinanceMetrics() {
    const revenueRows = await this.dataSource.query(`
      SELECT SUM(total_price) as total 
      FROM orders 
      WHERE status IN ('Confirmed', 'Shipped', 'Delivered');
    `);
    const revenue = Number(revenueRows[0]?.total || 0);

    const expenseRows = await this.dataSource.query(`
      SELECT SUM(amount) as total 
      FROM expenses 
      WHERE deleted_at IS NULL;
    `);
    const expenses = Number(expenseRows[0]?.total || 0);

    const pendingRows = await this.dataSource.query(`
      SELECT SUM(total_price) as total 
      FROM orders 
      WHERE status = 'Verification Pending';
    `);
    const pending = Number(pendingRows[0]?.total || 0);

    const invValueRows = await this.dataSource.query(`
      SELECT SUM(purchase_price * total_stock) as total 
      FROM products 
      WHERE deleted_at IS NULL;
    `);
    const inventoryValue = Number(invValueRows[0]?.total || 0);

    return {
      revenue,
      expenses,
      profit: revenue - expenses,
      pendingPayments: pending,
      inventoryValue
    };
  }

  // ── ANALYTICS METRICS CALCULATOR ───────────────────────────────────
  async getAnalyticsMetrics() {
    const topSeller = await this.dataSource.query(`
      SELECT p.model_name as name, p.brand, SUM(oi.qty) as sales
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
      GROUP BY p.id, p.model_name, p.brand
      ORDER BY sales DESC LIMIT 1;
    `);

    const topBrand = await this.dataSource.query(`
      SELECT p.brand, SUM(oi.qty) as sales
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
      GROUP BY p.brand
      ORDER BY sales DESC LIMIT 1;
    `);

    const avgOrderVal = await this.dataSource.query(`
      SELECT AVG(total_price) as val 
      FROM orders 
      WHERE status IN ('Confirmed', 'Shipped', 'Delivered');
    `);

    const topCust = await this.dataSource.query(`
      SELECT c.full_name as name, SUM(o.total_price) as spend
      FROM orders o
      JOIN users u ON u.id = o.user_id
      JOIN customers c ON c.email = u.email
      WHERE o.status IN ('Confirmed', 'Shipped', 'Delivered')
      GROUP BY c.id, c.full_name
      ORDER BY spend DESC LIMIT 1;
    `);

    // Dead Stock check: 90+ days unsold
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
      topBrand: topBrand[0]?.brand || null,
      averageOrderValue: Number(avgOrderVal[0]?.val || 0),
      topCustomer: topCust[0] || null,
      deadStockCount: deadStock.length,
      deadStock
    };
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
}
export default ApiService;
