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

  console.log("Starting reconciliation cleanup...");

  await client.query("BEGIN;");
  try {
    // 1. Delete Product 1 Batch 1 (a16fa465-1e0c-4497-85c7-0f98f66b5591) and its ledger entries
    const b1 = 'a16fa465-1e0c-4497-85c7-0f98f66b5591';
    const l1 = await client.query("DELETE FROM inventory_ledger WHERE batch_id = $1 RETURNING id", [b1]);
    console.log(`Deleted ${l1.rowCount} ledger rows for Batch 1 of Product 1.`);
    const bat1 = await client.query("DELETE FROM inventory_batches WHERE id = $1 RETURNING id", [b1]);
    console.log(`Deleted Batch 1 of Product 1.`);

    // 2. Delete Product 2 Batch 1 (c6049461-9c34-4bde-b84d-718849f208c5) and its ledger entries
    const b2 = 'c6049461-9c34-4bde-b84d-718849f208c5';
    const l2 = await client.query("DELETE FROM inventory_ledger WHERE batch_id = $1 RETURNING id", [b2]);
    console.log(`Deleted ${l2.rowCount} ledger rows for Batch 1 of Product 2.`);
    const bat2 = await client.query("DELETE FROM inventory_batches WHERE id = $1 RETURNING id", [b2]);
    console.log(`Deleted Batch 1 of Product 2.`);

    // 3. Delete manual ADJUST_ADD ledger entries for Batch 5 (268de241-384c-4873-8a3c-1985f5659c21)
    const b5 = '268de241-384c-4873-8a3c-1985f5659c21';
    const l5 = await client.query(`
      DELETE FROM inventory_ledger 
      WHERE batch_id = $1 
        AND type = 'ADJUST_ADD' 
        AND reason LIKE 'Product edit stock adjustment%'
      RETURNING id
    `, [b5]);
    console.log(`Deleted ${l5.rowCount} manual adjustment ledger rows for Batch 5.`);

    await client.query("COMMIT;");
    console.log("Reconciliation cleanup transaction committed successfully.");
  } catch (err) {
    await client.query("ROLLBACK;");
    console.error("Cleanup transaction failed and rolled back:", err);
  }

  // 4. Run the integrity reconciliation check again
  console.log("\nRunning integrity reconciliation check to verify...");
  const mismatches = [];
  
  const batchSums = await client.query(`
    SELECT 
      product_id,
      SUM(quantity_available)::int as sum_available,
      SUM(quantity_reserved)::int as sum_reserved,
      SUM(quantity_sold)::int as sum_sold,
      SUM(quantity_returned)::int as sum_returned,
      SUM(quantity_damaged)::int as sum_damaged
    FROM inventory_batches
    GROUP BY product_id
  `);
  
  for (const bs of batchSums.rows) {
    const inv = await client.query("SELECT * FROM inventory WHERE product_id = $1", [bs.product_id]);
    if (inv.rows.length === 0) {
      mismatches.push(`Product ID ${bs.product_id}: Inventory cache row missing.`);
      continue;
    }
    const i = inv.rows[0];
    if (i.quantity_available !== bs.sum_available ||
        i.quantity_reserved !== bs.sum_reserved ||
        i.quantity_sold !== bs.sum_sold ||
        i.quantity_returned !== bs.sum_returned ||
        i.quantity_damaged !== bs.sum_damaged) {
      mismatches.push(`Product ID ${bs.product_id}: Cache mismatch. Cache (Avail:${i.quantity_available}, Res:${i.quantity_reserved}, Sold:${i.quantity_sold}) vs Batches (Avail:${bs.sum_available}, Res:${bs.sum_reserved}, Sold:${bs.sum_sold}).`);
    }
  }
  
  const ledgerSums = await client.query(`
    SELECT 
      batch_id,
      SUM(quantity_changed)::int as total_change
    FROM inventory_ledger
    GROUP BY batch_id
  `);
  
  for (const ls of ledgerSums.rows) {
    const batch = await client.query("SELECT id, quantity_received, quantity_available, quantity_reserved, quantity_sold, quantity_returned, quantity_damaged FROM inventory_batches WHERE id = $1", [ls.batch_id]);
    if (batch.rows.length === 0) {
      mismatches.push(`Batch ID ${ls.batch_id}: Batch missing but exists in ledger.`);
      continue;
    }
    const b = batch.rows[0];
    if (b.quantity_available !== ls.total_change) {
      mismatches.push(`Batch ID ${ls.batch_id}: Ledger mismatch. Batch Available:${b.quantity_available} vs Ledger Total Change:${ls.total_change}.`);
    }
  }

  if (mismatches.length > 0) {
    console.warn(`❌ Inconsistencies still detected! (${mismatches.length})`);
    mismatches.forEach((m, idx) => console.log(`${idx + 1}. ${m}`));
  } else {
    console.log("✔ ALL INVENTORY MATCHES PERFECTLY!");
  }

  await client.end();
}

main().catch(console.error);
