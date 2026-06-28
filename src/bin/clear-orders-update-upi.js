import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';

dotenv.config();

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
  await client.connect();

  console.log("Starting order history clear + UPI settings update...");
  await client.query("BEGIN;");

  try {
    // 1. Update UPI settings
    const currentSettings = await client.query("SELECT value FROM global_settings WHERE key = 'app_settings';");
    const current = currentSettings.rows.length > 0 ? currentSettings.rows[0].value : {};
    const merged = {
      ...current,
      companyUpiId: 'sanchitjain0801@oksbi',
      upiQrImage: '/upi-qr.png'
    };
    await client.query(`
      INSERT INTO global_settings (key, value, updated_at)
      VALUES ('app_settings', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW();
    `, [merged]);
    console.log("✅ UPI settings updated:", { companyUpiId: merged.companyUpiId });

    // 2. Count orders before clearing
    const countRes = await client.query("SELECT COUNT(*) as cnt FROM orders;");
    console.log(`Orders to delete: ${countRes.rows[0].cnt}`);

    // 3. Clear order history (cascade via FK)
    await client.query("DELETE FROM order_items;");
    console.log("✅ order_items cleared");

    await client.query("DELETE FROM orders;");
    console.log("✅ orders cleared");

    await client.query("COMMIT;");
    console.log("✅ Transaction committed successfully.");
  } catch (error) {
    await client.query("ROLLBACK;");
    console.error("❌ Transaction failed, rolled back:", error.message);
  }

  await client.end();
}

run().catch(console.error);
