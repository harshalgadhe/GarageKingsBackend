import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class ApiService implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    // Automatically verify that our configuration table is initialized on startup
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS global_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // ── PRODUCTS Catalog ───────────────────────────────────────────────
  async getProducts() {
    return this.dataSource.query(`
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             pi.thumbnail_url as image, COALESCE(i.quantity_available, 10) as quantity,
             p.tags
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      LEFT JOIN inventory i ON i.product_id = p.id
      ORDER BY p.created_at DESC;
    `);
  }

  async addProduct(car: any) {
    const sku = car.sku || `SKU-${Date.now()}`;
    const prodRes = await this.dataSource.query(`
      INSERT INTO products (sku, brand, model_name, series, scale, rarity_level, base_price, description, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      car.tags || []
    ]);

    const productId = prodRes[0].id;

    if (car.image) {
      await this.dataSource.query(`
        INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
        VALUES ($1, $2, $3, $4, true);
      `, [productId, car.image, car.image, car.image]);
    }

    await this.dataSource.query(`
      INSERT INTO inventory (product_id, quantity_available, quantity_reserved)
      VALUES ($1, $2, 0)
      ON CONFLICT (product_id) DO UPDATE SET quantity_available = $2;
    `, [productId, Number(car.quantity || 10)]);

    return { id: productId, sku };
  }

  async updateProduct(id: string, car: any) {
    await this.dataSource.query(`
      UPDATE products 
      SET brand = $1, model_name = $2, series = $3, scale = $4, rarity_level = $5, base_price = $6, description = $7, tags = $8, updated_at = NOW()
      WHERE id = $9;
    `, [
      car.brand || 'MINI GT',
      car.name || 'Unknown Casting',
      car.series || '',
      car.scale || '1:64',
      car.lane || 'Standard Edition',
      Number(car.price || 0),
      car.description || '',
      car.tags || [],
      id
    ]);

    if (car.image) {
      await this.dataSource.query(`DELETE FROM product_images WHERE product_id = $1;`, [id]);
      await this.dataSource.query(`
        INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
        VALUES ($1, $2, $3, $4, true);
      `, [id, car.image, car.image, car.image]);
    }

    await this.dataSource.query(`
      INSERT INTO inventory (product_id, quantity_available, quantity_reserved)
      VALUES ($1, $2, 0)
      ON CONFLICT (product_id) DO UPDATE SET quantity_available = $2;
    `, [id, Number(car.quantity || 10)]);

    return { success: true };
  }

  async deleteProduct(id: string) {
    await this.dataSource.query(`DELETE FROM products WHERE id = $1;`, [id]);
    return { success: true };
  }

  // ── SETTINGS Endpoints ─────────────────────────────────────────────
  async getSettings() {
    const rows = await this.dataSource.query(`
      SELECT value FROM global_settings WHERE key = 'app_settings';
    `);
    return rows.length > 0 ? rows[0].value : { 
      showPrices: false,
      adminPath: '9f7a4b2c-8d1e-45a9-b3f6-c1d2e8a7b9f0',
      dropDate: '',
      dropTime: '20:00',
      dropLabel: 'Friday · 8:00 PM IST',
      dropDesc: 'Every Friday at 8 PM IST, we release a fresh batch of 1:64 heat.'
    };
  }

  async updateSettings(settings: any) {
    const current = await this.getSettings();
    const merged = { ...current, ...settings };
    await this.dataSource.query(`
      INSERT INTO global_settings (key, value, updated_at)
      VALUES ('app_settings', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW();
    `, [merged]);
    return merged;
  }

  // ── AUCTION Management ─────────────────────────────────────────────
  async getAuctions() {
    const rows = await this.dataSource.query(`
      SELECT ae.id, ae.title, ae.starting_bid as "startingPrice", 
             ae.reserve_price as "minBidIncrement", ae.start_time as "startDate", ae.end_time as "endDate", ae.status,
             p.brand, p.scale, p.description, pi.thumbnail_url as image
      FROM auction_events ae
      LEFT JOIN products p ON p.id = ae.product_id
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      ORDER BY ae.created_at DESC;
    `);
    
    return rows.map(r => ({
      ...r,
      endDate: r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '',
      endTime: r.endDate ? new Date(r.endDate).toTimeString().split(' ')[0].slice(0, 5) : '20:00'
    }));
  }

  async addAuction(auction: any) {
    const start = new Date().toISOString();
    const end = new Date(`${auction.endDate}T${auction.endTime || '20:00'}:00+05:30`).toISOString();
    
    // Create linked product catalog record
    const dummyProduct = await this.dataSource.query(`
      INSERT INTO products (sku, brand, model_name, base_price, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id;
    `, [
      `AUC-SKU-${Date.now()}`,
      auction.brand || 'MINI GT',
      auction.title,
      Number(auction.startingPrice || 0),
      auction.description || ''
    ]);

    const productId = dummyProduct[0].id;

    if (auction.image) {
      await this.dataSource.query(`
        INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
        VALUES ($1, $2, $3, $4, true);
      `, [productId, auction.image, auction.image, auction.image]);
    }

    await this.dataSource.query(`
      INSERT INTO auction_events (product_id, title, start_time, end_time, starting_bid, reserve_price, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'Active');
    `, [
      productId,
      auction.title,
      start,
      end,
      Number(auction.startingPrice || 0),
      Number(auction.minBidIncrement || 100)
    ]);

    return { success: true };
  }

  async updateAuction(id: string, auction: any) {
    const end = new Date(`${auction.endDate}T${auction.endTime || '20:00'}:00+05:30`).toISOString();
    
    await this.dataSource.query(`
      UPDATE auction_events 
      SET title = $1, end_time = $2, starting_bid = $3, reserve_price = $4, updated_at = NOW()
      WHERE id = $5;
    `, [
      auction.title,
      end,
      Number(auction.startingPrice),
      Number(auction.minBidIncrement),
      id
    ]);

    // Update details in linked product record
    const aeRow = await this.dataSource.query(`SELECT product_id FROM auction_events WHERE id = $1;`, [id]);
    if (aeRow && aeRow.length > 0) {
      const productId = aeRow[0].product_id;
      await this.dataSource.query(`
        UPDATE products
        SET brand = $1, description = $2, updated_at = NOW()
        WHERE id = $3;
      `, [auction.brand || 'MINI GT', auction.description || '', productId]);

      if (auction.image) {
        await this.dataSource.query(`DELETE FROM product_images WHERE product_id = $1;`, [productId]);
        await this.dataSource.query(`
          INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
          VALUES ($1, $2, $3, $4, true);
        `, [productId, auction.image, auction.image, auction.image]);
      }
    }

    return { success: true };
  }

  async deleteAuction(id: string) {
    await this.dataSource.query(`DELETE FROM auction_events WHERE id = $1;`, [id]);
    return { success: true };
  }

  async getAuctionBids(auctionId: string) {
    return this.dataSource.query(`
      SELECT ab.id, ab.amount, ab.created_at as timestamp, u.email as "bidderName", u.email as contact
      FROM auction_bids ab
      LEFT JOIN users u ON u.id = ab.user_id
      WHERE ab.auction_id = $1
      ORDER BY ab.amount DESC;
    `, [auctionId]);
  }

  async addAuctionBid(auctionId: string, userId: string, amount: number) {
    await this.dataSource.query(`
      INSERT INTO auction_bids (auction_id, user_id, amount)
      VALUES ($1, $2, $3);
    `, [auctionId, userId, amount]);
    return { success: true };
  }

  // ── CRM Customers ──────────────────────────────────────────────────
  async getCustomers() {
    return this.dataSource.query(`
      SELECT id, full_name, full_name as "fullName", phone, instagram, address, created_at, created_at as "createdAt"
      FROM customers
      ORDER BY created_at DESC;
    `);
  }

  async addCustomer(customer: any) {
    const fullName = customer.fullName || customer.full_name || 'Unknown Customer';
    const phone = customer.phone ? customer.phone.trim() : '';
    const instagram = customer.instagram || customer.insta || '';
    const address = customer.address || customer.addr || '';

    const res = await this.dataSource.query(`
      INSERT INTO customers (full_name, phone, instagram, address, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (phone) DO UPDATE 
      SET full_name = EXCLUDED.full_name,
          instagram = CASE WHEN EXCLUDED.instagram <> '' THEN EXCLUDED.instagram ELSE customers.instagram END,
          address = CASE WHEN EXCLUDED.address <> '' THEN EXCLUDED.address ELSE customers.address END,
          updated_at = NOW()
      RETURNING id;
    `, [fullName, phone, instagram, address]);
    return { id: res[0].id };
  }

  // ── CUSTOMERS E-COMMERCE ORDERS ──────────────────────────────────
  async placeOrder(userId: string, dto: any) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Double check inventory quantity
      const invCheck = await queryRunner.query(`
        SELECT quantity_available FROM inventory WHERE product_id = $1 FOR UPDATE;
      `, [dto.productId]);

      if (invCheck.length === 0 || invCheck[0].quantity_available < dto.qty) {
        throw new Error("Target die-cast grail is out of stock.");
      }

      // 2. Insert order row
      const orderRes = await queryRunner.query(`
        INSERT INTO orders (user_id, total_price, shipping_address, status)
        VALUES ($1, $2, $3, 'Pending')
        RETURNING id;
      `, [userId, Number(dto.priceAtPurchase * dto.qty), dto.shippingAddress]);
      
      const orderId = orderRes[0].id;

      // 3. Insert order item details
      await queryRunner.query(`
        INSERT INTO order_items (order_id, product_id, qty, price_at_purchase)
        VALUES ($1, $2, $3, $4);
      `, [orderId, dto.productId, dto.qty, Number(dto.priceAtPurchase)]);

      // 4. Decrement warehouse stock
      await queryRunner.query(`
        UPDATE inventory 
        SET quantity_available = quantity_available - $1, updated_at = NOW()
        WHERE product_id = $2;
      `, [dto.qty, dto.productId]);

      await queryRunner.commitTransaction();
      return { success: true, orderId };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async getCustomerOrders(email: string) {
    return this.dataSource.query(`
      SELECT o.id, o.status, o.total_price as "totalPrice", o.shipping_address as "shippingAddress", o.tracking_number as "trackingNumber", o.created_at as "createdAt",
             p.model_name as "productName", p.brand as "productBrand", oi.price_at_purchase as "priceAtPurchase", oi.qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
      JOIN users u ON u.id = o.user_id
      WHERE u.email = $1
      ORDER BY o.created_at DESC;
    `, [email]);
  }

  async getAdminOrders() {
    return this.dataSource.query(`
      SELECT o.id, o.status, o.total_price as "totalPrice", o.shipping_address as "shippingAddress", o.tracking_number as "trackingNumber", o.created_at as "createdAt",
             u.email as "customerEmail",
             p.model_name as "productName", p.brand as "productBrand", oi.price_at_purchase as "priceAtPurchase", oi.qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
      JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC;
    `);
  }

  async updateOrderStatus(id: string, status?: string, trackingNumber?: string) {
    if (status && trackingNumber !== undefined) {
      await this.dataSource.query(`
        UPDATE orders 
        SET status = $1, tracking_number = $2, updated_at = NOW()
        WHERE id = $3;
      `, [status, trackingNumber, id]);
    } else if (status) {
      await this.dataSource.query(`
        UPDATE orders 
        SET status = $1, updated_at = NOW()
        WHERE id = $2;
      `, [status, id]);
    } else if (trackingNumber !== undefined) {
      await this.dataSource.query(`
        UPDATE orders 
        SET tracking_number = $1, updated_at = NOW()
        WHERE id = $2;
      `, [trackingNumber, id]);
    }
    return { success: true };
  }

  async getOrCreateUser(cognitoSub: string, email: string) {
    const rows = await this.dataSource.query(`
      SELECT id FROM users WHERE email = $1;
    `, [email]);

    if (rows.length > 0) {
      return rows[0].id;
    }

    const newUser = await this.dataSource.query(`
      INSERT INTO users (cognito_sub, email)
      VALUES ($1, $2)
      RETURNING id;
    `, [cognitoSub, email]);
    
    return newUser[0].id;
  }
}
export default ApiService;
