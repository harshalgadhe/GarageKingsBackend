import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('c:/Users/harsh/Desktop/Project/GarageKings/server/.env') });

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
  await client.connect();

  const p1 = '653e3d85-bf8b-4c18-86a4-f26145ff9830';
  const p2 = '25756d8d-03de-4cc0-bc9d-36eb1fe6d81a';

  console.log("=== ALL LEDGER ENTRIES FOR PRODUCT 1 ===");
  const p1Ledgers = await client.query("SELECT * FROM inventory_ledger WHERE product_id = $1 ORDER BY created_at ASC", [p1]);
  console.log(p1Ledgers.rows);

  console.log("\n=== ALL LEDGER ENTRIES FOR PRODUCT 2 ===");
  const p2Ledgers = await client.query("SELECT * FROM inventory_ledger WHERE product_id = $1 ORDER BY created_at ASC", [p2]);
  console.log(p2Ledgers.rows);

  await client.end();
}

main().catch(console.error);
