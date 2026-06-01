import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';

// Load environment configurations
dotenv.config();

async function rollbackDatabase() {
  console.log("==================================================");
  console.log("GARAGEKINGS DATABASE RESET & ROLLBACK PROCEDURES");
  console.log("==================================================");

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  await client.connect();
  console.log("✔ Connected to database successfully.");

  const teardownSql = `
    DROP TABLE IF EXISTS dual_write_dlq CASCADE;
    DROP TABLE IF EXISTS id_mappings CASCADE;
    DROP TABLE IF EXISTS admin_audit_logs CASCADE;
    DROP TABLE IF EXISTS audit_logs CASCADE;
    DROP TABLE IF EXISTS migration_runs CASCADE;
    DROP TABLE IF EXISTS receipt_generation_jobs CASCADE;
    DROP TABLE IF EXISTS auction_winners CASCADE;
    DROP TABLE IF EXISTS auction_bids CASCADE;
    DROP TABLE IF EXISTS auction_events CASCADE;
    DROP TABLE IF EXISTS watchlists CASCADE;
    DROP TABLE IF EXISTS offers CASCADE;
    DROP TABLE IF EXISTS marketplace_listings CASCADE;
    DROP TABLE IF EXISTS notifications CASCADE;
    DROP TABLE IF EXISTS drop_products CASCADE;
    DROP TABLE IF EXISTS drops CASCADE;
    DROP TABLE IF EXISTS garage_item_images CASCADE;
    DROP TABLE IF EXISTS garage_items CASCADE;
    DROP TABLE IF EXISTS wishlists CASCADE;
    DROP TABLE IF EXISTS order_items CASCADE;
    DROP TABLE IF EXISTS orders CASCADE;
    DROP TABLE IF EXISTS receipt_items CASCADE;
    DROP TABLE IF EXISTS receipts CASCADE;
    DROP TABLE IF EXISTS customers CASCADE;
    DROP TABLE IF EXISTS inventory_transactions CASCADE;
    DROP TABLE IF EXISTS inventory CASCADE;
    DROP TABLE IF EXISTS product_images CASCADE;
    DROP TABLE IF EXISTS products CASCADE;
    DROP TABLE IF EXISTS profiles CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TYPE IF EXISTS inventory_tx_type CASCADE;
    DROP TYPE IF EXISTS order_status CASCADE;
    DROP TYPE IF EXISTS listing_status CASCADE;
    DROP TYPE IF EXISTS offer_status CASCADE;
    DROP TYPE IF EXISTS auction_status CASCADE;
    DROP TYPE IF EXISTS job_status CASCADE;
    DROP TYPE IF EXISTS migration_status CASCADE;
  `;

  console.log("Executing cascade teardown query...");
  await client.query('BEGIN');

  try {
    await client.query(teardownSql);
    await client.query('COMMIT');
    console.log("==================================================");
    console.log("✔ ALL DATABASE SCHEMAS DROPPED SUCCESSFULLY!");
    console.log("==================================================");
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("❌ Teardown failed! Rollback executed.", error);
  } finally {
    await client.end();
  }
}

rollbackDatabase().catch(err => {
  console.error("Uncaught rollback wrapper error:", err);
  process.exit(1);
});
