import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config({ path: 'C:/Users/harsh/Desktop/Project/GarageKings/server/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

// Read receipts
const rawData = fs.readFileSync('C:\\Users\\harsh\\.gemini\\antigravity\\brain\\7eac2fd3-0fc1-4fe1-bbf1-b2fcdac07a07\\scratch\\firebase_receipts.json', 'utf-8');
const receiptsList = JSON.parse(rawData);

// Try to insert just one receipt that should be new (not in dup list)
const r = receiptsList.find(rx => !['RT00021', 'RT00017', 'RT00048', 'RT00135', 'RT00064'].includes(rx.receiptNumber?.trim()));
console.log('Testing receipt:', r?.receiptNumber, 'Total:', r?.totalAmount);

const receiptNumber = r.receiptNumber?.trim();
const customerName = r.customerName || 'Collector';
const phone = r.customerPhone || '0000000000';
const emailClean = `${phone.replace(/[^0-9]/g, '')}@guest.garagekings.in`.toLowerCase();
const totalAmount = Number(r.totalAmount || 0);
const createdAt = r.createdAt ? new Date(r.createdAt) : new Date();

// Step 1: check current state
const existing = await client.query('SELECT id FROM receipts WHERE receipt_number = $1', [receiptNumber]);
console.log('Already exists?', existing.rows.length > 0);

try {
  // Step 2: upsert customer
  const custRes = await client.query(
    'INSERT INTO customers (full_name, phone, email, city) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id',
    [customerName, phone, emailClean, 'Unknown']
  );
  const customerId = custRes.rows[0].id;
  console.log('Customer ID:', customerId);

  // Step 3: insert receipt (no transaction, raw insert)
  const recRes = await client.query(
    `INSERT INTO receipts (receipt_number, customer_id, format_type, total_amount, customer_name, customer_phone, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [receiptNumber, customerId, 'standard', totalAmount, customerName, phone, createdAt]
  );
  console.log('Receipt inserted:', recRes.rows[0].id);
} catch(e) {
  console.error('Error:', e.message);
}

const finalCount = await client.query('SELECT COUNT(*) FROM receipts');
console.log('Receipt count after:', finalCount.rows[0].count);

await client.release();
await pool.end();
