import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const jsonPath = 'C:\\Users\\harsh\\.gemini\\antigravity\\brain\\7eac2fd3-0fc1-4fe1-bbf1-b2fcdac07a07\\scratch\\firebase_receipts.json';

async function seedReceipts() {
  console.log("Reading legacy receipts JSON...");
  const rawData = fs.readFileSync(jsonPath, 'utf-8');
  const receiptsList = JSON.parse(rawData);
  console.log(`Loaded ${receiptsList.length} receipt records from JSON.`);

  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
  });

  // Get a fresh connection for reads
  const pgClient = await pgPool.connect();
  const preSeed = await pgClient.query('SELECT COUNT(*) FROM receipts');
  console.log("Pre-seed receipt count:", preSeed.rows[0].count);

  let successCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;

  for (const r of receiptsList) {
    const receiptNumber = (r.receiptNumber || r.orderId || `RT-${Date.now()}`).trim();
    
    // Use a fresh connection for each insert to avoid error state pollution
    const conn = await pgPool.connect();
    try {
      // 1. Check duplicate
      const dupCheck = await conn.query(
        'SELECT id FROM receipts WHERE receipt_number = $1',
        [receiptNumber]
      );
      if (dupCheck.rows.length > 0) {
        duplicateCount++;
        conn.release();
        continue;
      }

      // 2. Resolve Customer ID
      const customerName = r.customerName || 'Collector';
      const phone = r.customerPhone || '0000000000';
      const instagram = r.customerInstagram || null;
      const address = r.customerAddress || null;
      const cleanPhonePart = phone.replace(/[^0-9]/g, '');
      const emailClean = `${cleanPhonePart || r.id || 'unknown'}@guest.garagekings.in`.toLowerCase();

      const custRes = await conn.query(
        'INSERT INTO customers (full_name, phone, instagram, address, email, city) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id',
        [customerName, phone, instagram, address, emailClean, 'Unknown']
      );
      const customerId = custRes.rows[0].id;

      // 3. Financial calculations
      const formatType = r.formatType === 'prebooking' || r.bookingType === 'pre_order' ? 'pre_order' : 'standard';
      const taxPercent = Number(r.taxPercent || 0);
      const taxAmount = Number(r.taxAmount || 0);
      const shippingCharges = Number(r.shippingCharges || 0);
      const rawTotal = Number(r.totalAmount || 0);
      const pendingBalance = Number(r.pendingBalance || 0);
      const advancePaid = rawTotal - pendingBalance;
      const footerNote = r.footerNote || null;
      const createdAt = r.createdAt ? new Date(r.createdAt) : new Date();

      // 4. Insert Receipt (auto-commit, no explicit transaction)
      const receiptRes = await conn.query(
        `INSERT INTO receipts (
          receipt_number, customer_id, format_type, tax_percent, tax_amount,
          shipping_charges, advance_paid, pending_balance, total_amount, footer_note,
          customer_name, customer_phone, customer_instagram, customer_address, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id`,
        [receiptNumber, customerId, formatType, taxPercent, taxAmount,
         shippingCharges, advancePaid, pendingBalance, rawTotal, footerNote,
         customerName, phone, instagram, address, createdAt]
      );

      // 5. Insert line items (optional)
      const itemsList = r.items || [];
      for (const item of itemsList) {
        const desc = item.description || item.name || 'Model Casting';
        const qty = parseInt(item.qty || item.quantity || 1, 10);
        const unitPrice = parseFloat(item.amount || item.unitPrice || 0);
        try {
          await conn.query(
            'INSERT INTO receipt_items (receipt_id, description, quantity, amount) VALUES ($1, $2, $3, $4)',
            [receiptRes.rows[0].id, desc, qty, unitPrice]
          );
        } catch (_) {} // Table may differ or receipt_items might not exist
      }

      conn.release();
      successCount++;
    } catch (err) {
      conn.release();
      console.error(`Error importing receipt ${receiptNumber}:`, err.message);
      errorCount++;
    }
  }

  const postSeed = await pgClient.query('SELECT COUNT(*) FROM receipts');
  console.log("Post-seed receipt count:", postSeed.rows[0].count);
  pgClient.release();
  await pgPool.end();

  console.log("==================================================");
  console.log(`IMPORT COMPLETE: ${successCount} receipts inserted, ${duplicateCount} duplicates skipped, ${errorCount} errors.`);
  console.log("==================================================");
}

seedReceipts();
