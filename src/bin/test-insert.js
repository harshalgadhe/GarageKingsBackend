import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config({ path: 'C:/Users/harsh/Desktop/Project/GarageKings/server/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const cust = await client.query(
    'INSERT INTO customers (full_name, phone, email, city) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id',
    ['Test Customer', '9999999999', 'test@guest.garagekings.in', 'Unknown']
  );
  const custId = cust.rows[0].id;
  console.log('Customer ID:', custId);
  const r = await client.query(
    'INSERT INTO receipts (receipt_number, customer_id, format_type, total_amount) VALUES ($1, $2, $3, $4) RETURNING id',
    ['TEST-DEBUG-001', custId, 'standard', 500]
  );
  console.log('Receipt inserted:', r.rows[0].id);
  await client.query('COMMIT');
} catch(e) {
  console.error('Error:', e.message);
  await client.query('ROLLBACK');
}
await client.release();
await pool.end();
