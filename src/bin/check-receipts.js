import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config({ path: 'C:/Users/harsh/Desktop/Project/GarageKings/server/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

// Delete test receipts
await client.query("DELETE FROM receipts WHERE receipt_number IN ('TEST-DEBUG-001')");
console.log('Cleaned test receipts');

const count = await client.query('SELECT COUNT(*) FROM receipts');
console.log('Current receipt count:', count.rows[0].count);

const sample = await client.query('SELECT receipt_number, customer_name, total_amount FROM receipts ORDER BY created_at DESC LIMIT 10');
console.log('Sample:', JSON.stringify(sample.rows, null, 2));

await client.release();
await pool.end();
