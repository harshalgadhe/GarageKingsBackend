import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('c:/Users/harsh/Desktop/Project/GarageKings/server/.env') });

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false
  });
  await client.connect();

  const b5 = '268de241-384c-4873-8a3c-1985f5659c21';

  console.log("=== BATCH 5 ===");
  const b5Info = await client.query("SELECT * FROM inventory_batches WHERE id = $1", [b5]);
  console.log("Batch info:", b5Info.rows);

  const b5Ledger = await client.query("SELECT * FROM inventory_ledger WHERE batch_id = $1", [b5]);
  console.log("Ledger entries:", b5Ledger.rows);

  if (b5Info.rows[0]) {
    const prodId = b5Info.rows[0].product_id;
    const prod = await client.query("SELECT * FROM products WHERE id = $1", [prodId]);
    console.log("Product:", prod.rows);
    const cache = await client.query("SELECT * FROM inventory WHERE product_id = $1", [prodId]);
    console.log("Cache:", cache.rows);
  }

  await client.end();
}

main().catch(console.error);
