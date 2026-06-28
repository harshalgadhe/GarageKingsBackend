import { Injectable, InternalServerErrorException, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface CreateReceiptItemDto {
  description: string;
  qty: number;
  amount: number;
  productId?: string;
}

export interface CreateReceiptDto {
  receiptNumber: string;
  customerId: string;
  formatType?: string;
  taxPercent?: number;
  shippingCharges?: number;
  advancePaid?: number;
  footerNote?: string;
  items: CreateReceiptItemDto[];
  customerName?: string;
  customerPhone?: string;
  customerInstagram?: string;
  customerAddress?: string;
}

@Injectable()
export class ReceiptsService implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    console.log('[Receipts] Running database check/alteration for customer fallback columns...');
    try {
      await this.dataSource.query(`
        ALTER TABLE receipts 
        ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50),
        ADD COLUMN IF NOT EXISTS customer_instagram VARCHAR(100),
        ADD COLUMN IF NOT EXISTS customer_address TEXT,
        ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL;
      `);
      console.log('✔ [Receipts] Fallback customer columns and order_id checked/added successfully.');
      
      // Ensure receipt_generation_jobs exists
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS receipt_generation_jobs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
          status VARCHAR(50) DEFAULT 'Pending',
          retry_count INT DEFAULT 0,
          max_retries INT DEFAULT 3,
          pdf_s3_url VARCHAR(512),
          error_log TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✔ [Receipts] receipt_generation_jobs table checked/created successfully.');
    } catch (err: any) {
      console.error('[Receipts] Failed to run receipts startup migrations:', err);
    }
  }

  /**
   * Secure, transaction-safe receipt generation service.
   * Executes invoice creation, maps line items, and updates inventory stock atomically.
   */
  async generateBillingReceipt(dto: CreateReceiptDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Calculate transaction sums & tax rates
      let lineItemsSum = 0;
      for (const item of dto.items) {
        lineItemsSum += Number(item.amount) * parseInt(item.qty.toString(), 10);
      }

      const shipping = Number(dto.shippingCharges || 0);
      const taxRate = Number(dto.taxPercent || 0) / 100;
      const taxVal = lineItemsSum * taxRate;
      const finalTotal = lineItemsSum + taxVal + shipping;

      const advance = Number(dto.advancePaid || 0);
      const balance = Math.max(0, finalTotal - advance);

      // 2. Resolve/seed Guest Customer and Guest User
      const phoneVal = (dto.customerPhone || '').trim() || '0000000000';
      const emailClean = (dto.customerPhone 
        ? `${dto.customerPhone.trim()}@guest.garagekings.in` 
        : `guest_${Date.now()}_${Math.floor(Math.random() * 1000)}@guest.garagekings.in`
      ).toLowerCase();

      const custRes = await queryRunner.query(`
        INSERT INTO customers (full_name, phone, instagram, address, email, city)
        VALUES ($1, $2, $3, $4, $5, 'Unknown')
        ON CONFLICT (phone) DO UPDATE 
        SET full_name = EXCLUDED.full_name, instagram = EXCLUDED.instagram, address = EXCLUDED.address, email = COALESCE(customers.email, EXCLUDED.email)
        RETURNING id;
      `, [dto.customerName || 'Guest Customer', phoneVal, dto.customerInstagram || '', dto.customerAddress || '', emailClean]);
      const customerId = custRes[0].id;

      const userRes = await queryRunner.query(`
        INSERT INTO users (email, cognito_sub)
        VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id;
      `, [emailClean, `guest_${customerId}`]);
      const userId = userRes[0].id;

      // 3. Create parent Pending/Confirmed order record
      const orderStatus = dto.formatType === 'pre_order' ? 'Pre-Order' : 'Confirmed';
      const orderRes = await queryRunner.query(`
        INSERT INTO orders (user_id, total_price, shipping_address, status, booking_type, advance_amount, remaining_amount, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING id;
      `, [userId, finalTotal, `${dto.customerAddress || ''} | Insta: ${dto.customerInstagram || ''} | Phone: ${dto.customerPhone || ''}`, orderStatus, dto.formatType || 'standard', advance, balance]);
      const orderId = orderRes[0].id;

      // 4. Process line items: check stock, insert order_items, decrement inventory
      for (const item of dto.items) {
        if (!item.productId) {
          throw new Error(`Product ID is required for item: ${item.description}`);
        }

        // Insert e-commerce order item
        await queryRunner.query(`
          INSERT INTO order_items (order_id, product_id, qty, price_at_purchase)
          VALUES ($1, $2, $3, $4);
        `, [orderId, item.productId, parseInt(item.qty.toString(), 10), Number(item.amount)]);

        // Row-level lock and verify product stock
        const prodRows = await queryRunner.query(`
          SELECT id, model_name as name, total_stock, sold_stock, locked_stock
          FROM products 
          WHERE id = $1 AND deleted_at IS NULL 
          FOR UPDATE;
        `, [item.productId]);

        if (prodRows.length === 0) {
          throw new Error(`Casting with product ID "${item.productId}" does not exist or has been de-listed.`);
        }

        const p = prodRows[0];
        const available = Number(p.total_stock) - Number(p.locked_stock || 0) - Number(p.sold_stock);
        if (available < Number(item.qty)) {
          throw new Error(`Casting "${p.name}" is sold out. Available: ${available}, requested: ${item.qty}.`);
        }

        // Increment sold_stock in products table
        await queryRunner.query(`
          UPDATE products 
          SET sold_stock = sold_stock + $1,
              updated_at = NOW() 
          WHERE id = $2;
        `, [Number(item.qty), item.productId]);

        // Update quantity_available in inventory table to match sold deduction
        await queryRunner.query(`
          UPDATE inventory 
          SET quantity_available = quantity_available - $1,
              updated_at = NOW()
          WHERE product_id = $2;
        `, [Number(item.qty), item.productId]);
      }

      // 5. Insert receipt row metadata linked to order_id
      const receiptInsertQuery = `
        INSERT INTO receipts (receipt_number, customer_id, order_id, format_type, tax_percent, tax_amount, shipping_charges, total_amount, advance_paid, pending_balance, footer_note, customer_name, customer_phone, customer_instagram, customer_address)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id, created_at;
      `;
      const receiptRes = await queryRunner.query(receiptInsertQuery, [
        dto.receiptNumber.trim(),
        customerId,
        orderId,
        dto.formatType || 'standard',
        Number(dto.taxPercent || 0),
        taxVal,
        shipping,
        finalTotal,
        advance,
        balance,
        dto.footerNote || null,
        dto.customerName || null,
        dto.customerPhone || null,
        dto.customerInstagram || null,
        dto.customerAddress || null
      ]);

      const receiptId = receiptRes[0].id;

      // 6. Normalize and insert separate child items
      const itemInsertQuery = `
        INSERT INTO receipt_items (receipt_id, description, qty, amount)
        VALUES ($1, $2, $3, $4);
      `;
      for (const item of dto.items) {
        await queryRunner.query(itemInsertQuery, [
          receiptId,
          item.description.trim(),
          parseInt(item.qty.toString(), 10),
          Number(item.amount)
        ]);
      }

      // 7. Initialize active status in receipt_generation_jobs table
      const jobInsertQuery = `
        INSERT INTO receipt_generation_jobs (receipt_id, status)
        VALUES ($1, 'Pending');
      `;
      await queryRunner.query(jobInsertQuery, [receiptId]);

      // 8. Record security audit trail
      const auditLogQuery = `
        INSERT INTO audit_logs (action, entity, entity_id, after_state)
        VALUES ('RECEIPT_GENERATED', 'receipts', $1, $2);
      `;
      await queryRunner.query(auditLogQuery, [
        receiptId,
        JSON.stringify({ receiptNumber: dto.receiptNumber, totalAmount: finalTotal, orderId })
      ]);

      // COMMIT TRANSACTION
      await queryRunner.commitTransaction();

      return {
        success: true,
        receiptId,
        receiptNumber: dto.receiptNumber,
        totalAmount: finalTotal,
        pendingBalance: balance,
        createdAt: receiptRes[0].created_at,
        orderId
      };

    } catch (error: any) {
      // ROLLBACK SQL TRANSACTION ON ERROR TO KEEP DB IMMUTABLE
      await queryRunner.rollbackTransaction();
      console.error('TypeORM QueryRunner Rolled Back:', error);
      throw new InternalServerErrorException(error.message || 'Receipt Generation failed.');
    } finally {
      // CRITICAL: Always release QueryRunner to return connection pool!
      await queryRunner.release();
    }
  }

  async getReceipts() {
    try {
      const receipts = await this.dataSource.query(`
        SELECT r.*, 
               COALESCE(r.customer_name, c.full_name) as customer_name, 
               COALESCE(r.customer_phone, c.phone) as customer_phone, 
               COALESCE(r.customer_address, c.address) as customer_address,
               COALESCE(r.customer_instagram, c.instagram) as customer_instagram
        FROM receipts r
        JOIN customers c ON r.customer_id = c.id
        ORDER BY r.created_at DESC;
      `);
      
      // Fetch line items for each receipt
      for (const r of receipts) {
        r.items = await this.dataSource.query(`
          SELECT * FROM receipt_items WHERE receipt_id = $1;
        `, [r.id]);
      }
      
      return receipts;
    } catch (error: any) {
      console.error('getReceipts failed:', error);
      throw new InternalServerErrorException(error.message || 'Failed to retrieve receipts.');
    }
  }

  async deleteReceipt(id: string) {
    try {
      await this.dataSource.query(`
        DELETE FROM receipts WHERE id = $1;
      `, [id]);
      return { success: true };
    } catch (error: any) {
      console.error('deleteReceipt failed:', error);
      throw new InternalServerErrorException(error.message || 'Failed to delete receipt.');
    }
  }
}
export default ReceiptsService;
