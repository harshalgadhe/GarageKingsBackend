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
  console.log("DATABASE_URL:", process.env.DATABASE_URL?.substring(0, 80));
  console.log("Reading legacy receipts JSON...");
  
  const rawData = fs.readFileSync(jsonPath, 'utf-8');
  const receiptsList = JSON.parse(rawData);
  console.log(`Loaded ${receiptsList.length} receipt records from JSON.`);

  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const pgClient = await pgPool.connect();
  console.log("Connected to PostgreSQL.");
  
  const preSeed = await pgClient.query('SELECT COUNT(*) FROM receipts');
  console.log("Pre-seed receipt count:", preSeed.rows[0].count);

  let successCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const r of receiptsList.slice(0, 5)) {  // Only first 5 for debugging
    const receiptNumber = (r.receiptNumber || r.orderId || `RT-${Date.now()}`).trim();
    
    try {
      await pgClient.query('BEGIN');

      // 1. Check duplicate
      const dupCheck = await pgClient.query(
        'SELECT id FROM receipts WHERE receipt_number = $1',
        [receiptNumber]
      );
      if (dupCheck.rows.length > 0) {
        duplicateCount++;
        await pgClient.query('ROLLBACK');
        console.log(`  SKIP (dup): ${receiptNumber}`);
        continue;
      }

      // 2. Resolve Customer ID
      const customerName = r.customerName || 'Collector';
      const phone = r.customerPhone || '0000000000';
      const instagram = r.customerInstagram || null;
      const address = r.customerAddress || null;
      const cleanPhonePart = phone.replace(/[^0-9]/g, '');
      const emailClean = `${cleanPhonePart || r.id || 'unknown'}@guest.garagekings.in`.toLowerCase();

      let customerId;
      const custCheck = await pgClient.query('SELECT id FROM customers WHERE email = $1', [emailClean]);
      if (custCheck.rows.length > 0) {
        customerId = custCheck.rows[0].id;
      } else {
        const insertCust = await pgClient.query(
          'INSERT INTO customers (full_name, phone, instagram, address, email, city) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id',
          [customerName, phone, instagram, address, emailClean, 'Unknown']
        );
        customerId = insertCust.rows[0].id;
      }

      // 3. Financial calculations
      const formatType = 'standard';
      const totalAmount = Number(r.totalAmount || 0);
      const pendingBalance = Number(r.pendingBalance || 0);
      const advancePaid = totalAmount - pendingBalance;
      const createdAt = r.createdAt ? new Date(r.createdAt) : new Date();

      // 4. Insert Receipt
      const receiptRes = await pgClient.query(
        `INSERT INTO receipts (
          receipt_number, customer_id, format_type, tax_percent, tax_amount,
          shipping_charges, advance_paid, pending_balance, total_amount, footer_note,
          customer_name, customer_phone, customer_instagram, customer_address, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id`,
        [receiptNumber, customerId, formatType, 0, 0, 0, advancePaid, pendingBalance, totalAmount, null,
         customerName, phone, instagram, address, createdAt]
      );

      await pgClient.query('COMMIT');
      successCount++;
      console.log(`  OK: ${receiptNumber} -> ${receiptRes.rows[0].id}`);
    } catch (err) {
      await pgClient.query('ROLLBACK');
      console.error(`  ERR: ${receiptNumber}: ${err.message}`);
      errors.push({ receipt: receiptNumber, error: err.message });
      errorCount++;
    }
  }

  const postSeed = await pgClient.query('SELECT COUNT(*) FROM receipts');
  console.log("Post-seed receipt count:", postSeed.rows[0].count);
  console.log(`Success: ${successCount}, Dups: ${duplicateCount}, Errors: ${errorCount}`);
  if (errors.length) console.log('Errors:', JSON.stringify(errors, null, 2));
  
  pgClient.release();
  await pgPool.end();
}

seedReceipts();
