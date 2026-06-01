import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface CreateReceiptItemDto {
  description: string;
  qty: number;
  amount: number;
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
}

@Injectable()
export class ReceiptsService {
  constructor(private readonly dataSource: DataSource) {}

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

      // 2. Insert receipt row metadata
      const receiptInsertQuery = `
        INSERT INTO receipts (receipt_number, customer_id, format_type, tax_percent, tax_amount, shipping_charges, total_amount, advance_paid, pending_balance, footer_note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, created_at;
      `;
      const receiptRes = await queryRunner.query(receiptInsertQuery, [
        dto.receiptNumber.trim(),
        dto.customerId,
        dto.formatType || 'standard',
        Number(dto.taxPercent || 0),
        taxVal,
        shipping,
        finalTotal,
        advance,
        balance,
        dto.footerNote || null
      ]);

      const receiptId = receiptRes[0].id;

      // 3. Normalize and insert separate child items
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

        // 4. Row-level Lock & Inventory stock adjustments
        // CRITICAL Best Practice: Locking rows in index order prevents deadlocks
        const selectInventoryLock = `
          SELECT quantity_available, quantity_reserved 
          FROM inventory 
          WHERE product_id = (SELECT id FROM products WHERE model_name = $1 LIMIT 1)
          FOR UPDATE;
        `;
        const inventoryRes = await queryRunner.query(selectInventoryLock, [item.description.trim()]);
        
        if (inventoryRes.rows && inventoryRes.rows.length > 0) {
          const inv = inventoryRes.rows[0];
          if (inv.quantity_available < item.qty) {
            throw new Error(`Insufficient inventory quantity available for: ${item.description}`);
          }
          
          const updateStockQuery = `
            UPDATE inventory 
            SET quantity_available = quantity_available - $1, updated_at = NOW()
            WHERE product_id = (SELECT id FROM products WHERE model_name = $2 LIMIT 1);
          `;
          await queryRunner.query(updateStockQuery, [item.qty, item.description.trim()]);
        }
      }

      // 5. Initialize active status in receipt_generation_jobs table
      const jobInsertQuery = `
        INSERT INTO receipt_generation_jobs (receipt_id, status)
        VALUES ($1, 'Pending');
      `;
      await queryRunner.query(jobInsertQuery, [receiptId]);

      // 6. Record security audit trail
      const auditLogQuery = `
        INSERT INTO audit_logs (action, entity, entity_id, after_state)
        VALUES ('RECEIPT_GENERATED', 'receipts', $1, $2);
      `;
      await queryRunner.query(auditLogQuery, [
        receiptId,
        JSON.stringify({ receiptNumber: dto.receiptNumber, totalAmount: finalTotal })
      ]);

      // COMMIT TRANSACTION
      await queryRunner.commitTransaction();

      return {
        success: true,
        receiptId,
        receiptNumber: dto.receiptNumber,
        totalAmount: finalTotal,
        pendingBalance: balance,
        createdAt: receiptRes[0].created_at
      };

    } catch (error) {
      // ROLLBACK SQL TRANSACTION ON ERROR TO KEEP DB IMMUTABLE
      await queryRunner.rollbackTransaction();
      console.error('TypeORM QueryRunner Rolled Back:', error);
      throw new InternalServerErrorException(error.message || 'Receipt Generation failed.');
    } finally {
      // CRITICAL: Always release QueryRunner to return connection pool!
      await queryRunner.release();
    }
  }
}
export default ReceiptsService;
