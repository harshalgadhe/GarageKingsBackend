import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, limit, query, startAfter, orderBy } from 'firebase/firestore';
import pkg from 'pg';
const { Pool } = pkg;
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

// Load environment configurations
dotenv.config();

const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID
};

const report = {
  runId: null,
  productsImported: 0,
  failedImports: 0,
  duplicatesDetected: 0,
  inventoryCreated: 0,
  imagesCreated: 0,
  startedAt: new Date().toISOString(),
  details: []
};

async function executeMigrationPipeline() {
  console.log("==================================================");
  console.log("GARAGEKINGS FIREBASE MIGRATION RUNNER");
  console.log(`Started at: ${report.startedAt}`);
  console.log("==================================================");

  // 1. Init Database Connections
  const fbApp = initializeApp(firebaseConfig);
  const firestore = getFirestore(fbApp);

  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  const pgClient = await pgPool.connect();
  console.log("✔ Connected to RDS PostgreSQL.");

  // 2. Initialize Migration Log in database
  const initRunQuery = `
    INSERT INTO migration_runs (status, executed_by)
    VALUES ('Started', 'Firebase Migration Script')
    RETURNING id;
  `;
  const runRes = await pgClient.query(initRunQuery);
  report.runId = runRes.rows[0].id;
  console.log(`✔ Created audit log migration run ID: ${report.runId}`);

  const processedImages = new Set();

  try {
    let lastVisibleDoc = null;
    let hasMore = true;
    const batchSize = 100;
    let batchIndex = 1;

    // Outer pagination batch loop
    while (hasMore) {
      console.log(`Processing Batch #${batchIndex}...`);
      
      let fbQuery = query(
        collection(firestore, 'cars'),
        orderBy('createdAt'),
        limit(batchSize)
      );

      if (lastVisibleDoc) {
        fbQuery = query(
          collection(firestore, 'cars'),
          orderBy('createdAt'),
          startAfter(lastVisibleDoc),
          limit(batchSize)
        );
      }

      const snapshot = await getDocs(fbQuery);
      if (snapshot.empty) {
        hasMore = false;
        break;
      }

      lastVisibleDoc = snapshot.docs[snapshot.docs.length - 1];

      // Inner transaction block loop
      for (const fbDoc of snapshot.docs) {
        const car = fbDoc.data();
        const sku = car.sku || `SKU-MIG-${fbDoc.id}`;

        await pgClient.query('BEGIN');

        try {
          // A. Duplicate prevention checks
          const dupCheck = await pgClient.query(
            'SELECT id FROM products WHERE sku = $1',
            [sku]
          );

          if (dupCheck.rows.length > 0) {
            report.duplicatesDetected++;
            report.details.push({
              docId: fbDoc.id,
              sku,
              status: 'DUPLICATE',
              error: 'SKU conflict detected'
            });
            await pgClient.query('ROLLBACK');
            continue;
          }

          // B. Insert Product Core metadata
          const prodQuery = `
            INSERT INTO products (sku, brand, model_name, series, scale, rarity_level, base_price, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id;
          `;
          const prodRes = await pgClient.query(prodQuery, [
            sku,
            car.brand || 'MINI GT',
            car.modelName || car.name || 'Unknown Casting',
            car.series || 'Collector Series',
            car.scale || '1:64',
            car.rarity || 'Standard Edition',
            Number(car.price || 0),
            car.description || 'Premium collector die-cast model.'
          ]);

          const productId = prodRes.rows[0].id;

          // C. Image Deduplication & Relational Mapping
          if (car.image) {
            const imageUrl = car.image.trim();
            if (!processedImages.has(imageUrl)) {
              const imgQuery = `
                INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
                VALUES ($1, $2, $3, $4, $5);
              `;
              await pgClient.query(imgQuery, [productId, imageUrl, imageUrl, imageUrl, true]);
              processedImages.add(imageUrl);
              report.imagesCreated++;
            }
          }

          // D. Initialize Inventory tracking
          const invQuery = `
            INSERT INTO inventory (product_id, quantity_available, quantity_reserved, warehouse_shelf_location)
            VALUES ($1, $2, $3, $4);
          `;
          await pgClient.query(invQuery, [
            productId,
            Number(car.quantity || car.stock || 10),
            0,
            car.shelfLocation || 'Shelf-A1'
          ]);

          // E. Record initial Inventory Transaction log
          const txQuery = `
            INSERT INTO inventory_transactions (product_id, type, quantity_changed, reason, admin_user_id)
            VALUES ($1, 'Added', $2, 'Firebase Migration Sync restock', null);
          `;
          await pgClient.query(txQuery, [productId, Number(car.quantity || car.stock || 10)]);

          // COMMIT IF ALL COMMITTED SUCCESS
          await pgClient.query('COMMIT');
          report.productsImported++;
          report.inventoryCreated++;

          report.details.push({
            docId: fbDoc.id,
            sku,
            status: 'SUCCESS',
            error: ''
          });

        } catch (innerError) {
          await pgClient.query('ROLLBACK');
          report.failedImports++;
          console.error(`❌ Rollback on document: ${fbDoc.id}`, innerError);
          report.details.push({
            docId: fbDoc.id,
            sku,
            status: 'FAILED',
            error: innerError.message
          });
        }
      }

      if (snapshot.size < batchSize) {
        hasMore = false;
        break;
      }
      batchIndex++;
    }

    // 3. Update Migration Run Log with complete metrics
    const finalUpdate = `
      UPDATE migration_runs 
      SET status = 'Completed', records_processed = $1, records_failed = $2, completed_at = NOW() 
      WHERE id = $3;
    `;
    await pgClient.query(finalUpdate, [report.productsImported, report.failedImports, report.runId]);
    console.log("✔ Saved migration runs summary in database.");

    generateReportCSV();

  } catch (error) {
    console.error("Critical error in migration script:", error);
    await pgClient.query(
      "UPDATE migration_runs SET status = 'Failed', error_summary = $1, completed_at = NOW() WHERE id = $2",
      [error.message, report.runId]
    );
  } finally {
    pgClient.release();
    await pgPool.end();
  }
}

function generateReportCSV() {
  const headers = ['document_id', 'sku', 'import_status', 'error_log'];
  const csvRows = [headers.join(',')];

  for (const record of report.details) {
    const row = [
      record.docId,
      record.sku,
      record.status,
      `"${record.error.replace(/"/g, '""')}"`
    ];
    csvRows.push(row.join(','));
  }

  const csvContent = csvRows.join('\n');
  const reportPath = path.join(process.cwd(), 'migration_reconciliation_report.csv');
  fs.writeFileSync(reportPath, csvContent, 'utf-8');

  console.log("==================================================");
  console.log("MIGRATION SUMMARY REPORT");
  console.log("==================================================");
  console.log(`Products Imported:    ${report.productsImported}`);
  console.log(`Failed Imports:       ${report.failedImports}`);
  console.log(`Duplicates Blocked:   ${report.duplicatesDetected}`);
  console.log(`Report CSV Exported:  ${reportPath}`);
  console.log("==================================================");
}

executeMigrationPipeline().catch(console.error);
