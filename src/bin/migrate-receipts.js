import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import { getAuth, createUserWithEmailAndPassword } from 'firebase/auth';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

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
  receiptsImported: 0,
  failedImports: 0,
  duplicatesDetected: 0,
  customersCreated: 0,
  startedAt: new Date().toISOString(),
  details: []
};

async function executeMigrationPipeline() {
  console.log("==================================================");
  console.log("GARAGEKINGS FIREBASE RECEIPTS MIGRATION RUNNER");
  console.log(`Started at: ${report.startedAt}`);
  console.log("==================================================");

  // 1. Init Connections
  const fbApp = initializeApp(firebaseConfig);
  const auth = getAuth(fbApp);
  const firestore = getFirestore(fbApp);

  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  const pgClient = await pgPool.connect();
  console.log("✔ Connected to PostgreSQL database.");

  // 2. Auth dynamically
  const email = `receipts_migrator_${Date.now()}@example.com`;
  const password = "MigratePassword123!";
  console.log(`Signing up user dynamically: ${email}`);
  const userCredential = await createUserWithEmailAndPassword(auth, email, password);
  console.log("✔ Authenticated with Firebase Auth. UID:", userCredential.user.uid);

  // 3. Create Migration Log in PostgreSQL
  const initRunQuery = `
    INSERT INTO migration_runs (status, executed_by)
    VALUES ('Started', 'Firebase Receipts Migration Script')
    RETURNING id;
  `;
  const runRes = await pgClient.query(initRunQuery);
  report.runId = runRes.rows[0].id;
  console.log(`✔ Created audit log migration run ID: ${report.runId}`);

  try {
    console.log("Fetching receipts from Firestore...");
    const snapshot = await getDocs(collection(firestore, 'receipts'));
    console.log(`Found ${snapshot.size} receipts in Firestore. Starting import...`);

    for (const fbDoc of snapshot.docs) {
      const receipt = fbDoc.data();
      const receiptNumber = (receipt.receiptNumber || `RT-MIG-${fbDoc.id}`).trim();

      await pgClient.query('BEGIN');

      try {
        // A. Duplicate check
        const dupCheck = await pgClient.query(
          'SELECT id FROM receipts WHERE receipt_number = $1',
          [receiptNumber]
        );

        if (dupCheck.rows.length > 0) {
          report.duplicatesDetected++;
          report.details.push({
            docId: fbDoc.id,
            receiptNumber,
            status: 'DUPLICATE',
            error: 'Receipt number conflict'
          });
          await pgClient.query('ROLLBACK');
          continue;
        }

        // B. Parse customer & resolve customer_id
        const customerName = receipt.customerName || 'Unknown Customer';
        const rawPhone = receipt.customerPhone || '';
        const phone = rawPhone.trim() && rawPhone.trim() !== 'NA' ? rawPhone.trim() : `unknown_${fbDoc.id}`;
        const instagram = receipt.customerInstagram || null;
        const address = receipt.customerAddress || null;

        let customerId;
        const custCheck = await pgClient.query(
          'SELECT id FROM customers WHERE phone = $1',
          [phone]
        );

        if (custCheck.rows.length > 0) {
          customerId = custCheck.rows[0].id;
        } else {
          const insertCust = await pgClient.query(`
            INSERT INTO customers (full_name, phone, instagram, address)
            VALUES ($1, $2, $3, $4)
            RETURNING id;
          `, [customerName, phone, instagram, address]);
          customerId = insertCust.rows[0].id;
          report.customersCreated++;
        }

        // C. Insert Receipt metadata
        const formatType = receipt.formatType || 'standard';
        const taxPercent = Number(receipt.taxPercent || 0);
        const taxAmount = Number(receipt.taxAmount || 0);
        const shippingCharges = Number(receipt.shippingCharges || 0);
        const totalAmount = Number(receipt.totalAmount || 0);
        const pendingBalance = Number(receipt.pendingBalance || 0);
        
        // For prebooking, Firestore totalAmount is advance paid. Otherwise default to totalAmount
        const advancePaid = formatType === 'prebooking' ? totalAmount : totalAmount - pendingBalance;
        const footerNote = receipt.footerNote || null;
        const createdAt = receipt.createdAt ? new Date(receipt.createdAt) : new Date();

        const receiptInsertQuery = `
          INSERT INTO receipts (receipt_number, customer_id, format_type, tax_percent, tax_amount, shipping_charges, total_amount, advance_paid, pending_balance, footer_note, customer_name, customer_phone, customer_instagram, customer_address, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING id;
        `;
        const receiptRes = await pgClient.query(receiptInsertQuery, [
          receiptNumber,
          customerId,
          formatType,
          taxPercent,
          taxAmount,
          shippingCharges,
          totalAmount,
          advancePaid,
          pendingBalance,
          footerNote,
          customerName,
          phone,
          instagram,
          address,
          createdAt
        ]);
        const receiptId = receiptRes.rows[0].id;

        // D. Insert Receipt Line Items
        const items = receipt.items || [];
        const itemInsertQuery = `
          INSERT INTO receipt_items (receipt_id, description, qty, amount)
          VALUES ($1, $2, $3, $4);
        `;
        for (const item of items) {
          await pgClient.query(itemInsertQuery, [
            receiptId,
            (item.description || 'Line Item').trim(),
            parseInt(item.qty || item.quantity || 1, 10),
            Number(item.amount || 0)
          ]);
        }

        await pgClient.query('COMMIT');
        report.receiptsImported++;
        report.details.push({
          docId: fbDoc.id,
          receiptNumber,
          status: 'SUCCESS',
          error: ''
        });

      } catch (innerError) {
        await pgClient.query('ROLLBACK');
        report.failedImports++;
        console.error(`❌ Rollback on document: ${fbDoc.id}`, innerError);
        report.details.push({
          docId: fbDoc.id,
          receiptNumber,
          status: 'FAILED',
          error: innerError.message
        });
      }
    }

    // 4. Update migration runs
    const finalUpdate = `
      UPDATE migration_runs 
      SET status = 'Completed', records_processed = $1, records_failed = $2, completed_at = NOW() 
      WHERE id = $3;
    `;
    await pgClient.query(finalUpdate, [report.receiptsImported, report.failedImports, report.runId]);
    console.log("✔ Saved migration runs summary in database.");

    generateReportCSV();

  } catch (error) {
    console.error("Critical error in migration pipeline:", error);
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
  const headers = ['document_id', 'receipt_number', 'import_status', 'error_log'];
  const csvRows = [headers.join(',')];

  for (const record of report.details) {
    const row = [
      record.docId,
      record.receiptNumber,
      record.status,
      `"${record.error.replace(/"/g, '""')}"`
    ];
    csvRows.push(row.join(','));
  }

  const csvContent = csvRows.join('\n');
  const reportPath = path.join(process.cwd(), 'receipts_migration_report.csv');
  fs.writeFileSync(reportPath, csvContent, 'utf-8');

  console.log("==================================================");
  console.log("RECEIPTS MIGRATION SUMMARY REPORT");
  console.log("==================================================");
  console.log(`Receipts Imported:    ${report.receiptsImported}`);
  console.log(`Failed Imports:       ${report.failedImports}`);
  console.log(`Duplicates Blocked:   ${report.duplicatesDetected}`);
  console.log(`Customers Created:    ${report.customersCreated}`);
  console.log(`Report CSV Exported:  ${reportPath}`);
  console.log("==================================================");
}

executeMigrationPipeline().catch(console.error);
