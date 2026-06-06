import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';

dotenv.config();

async function runMigration() {
  console.log("Starting tags column migration...");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  await client.connect();
  console.log("✔ Connected to PostgreSQL database.");

  await client.query(`
    ALTER TABLE products 
    ADD COLUMN IF NOT EXISTS tags VARCHAR(50)[] DEFAULT '{}'::VARCHAR[];
  `);
  console.log("✔ Added 'tags' column to 'products' table.");

  await client.end();
  console.log("Migration finished successfully.");
}

runMigration().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
