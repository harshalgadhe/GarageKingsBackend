import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config({ path: 'C:/Users/harsh/Desktop/Project/GarageKings/server/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

const checkDef = await client.query(`
  SELECT cc.constraint_name, cc.check_clause
  FROM information_schema.check_constraints cc
  WHERE cc.constraint_name = 'chk_receipt_total'
`);
console.log('Check constraint definition:', checkDef.rows);

// Also check if there's a UNIQUE constraint on receipt_number  
const uniqueCheck = await client.query(`
  SELECT conname, pg_get_constraintdef(oid) as definition
  FROM pg_constraint
  WHERE conrelid = 'receipts'::regclass
`);
console.log('\nAll constraints with definitions:');
uniqueCheck.rows.forEach(c => console.log(`  ${c.conname}: ${c.definition}`));

await client.release();
await pool.end();
