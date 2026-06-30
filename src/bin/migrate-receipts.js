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
  ordersCreated: 0,
  startedAt: new Date().toISOString(),
  details: []
};

// Helper to resolve product ID from description or SKU
async function findProductId(pgClient, description) {
  if (!description) return null;
  
  // Try extracting SKU patterns: "SKU-...", "GT...", "HT..."
  const skuMatch = description.match(/SKU-[A-Za-z0-9-]+/i) || description.match(/GT[0-9]+/i) || description.match(/HT[A-Z0-9]+/i);
  if (skuMatch) {
    const sku = skuMatch[0].toUpperCase();
    const res = await pgClient.query('SELECT id FROM products WHERE UPPER(sku) = $1', [sku]);
    if (res.rows.length > 0) return res.rows[0].id;
  }
  
  // Try name match before the hyphen
  const namePart = description.split('-')[0].trim();
  if (namePart) {
    const res = await pgClient.query('SELECT id FROM products WHERE LOWER(model_name) = LOWER($1)', [namePart]);
    if (res.rows.length > 0) return res.rows[0].id;
  }

  // Fallback to first product
  const fallbackRes = await pgClient.query('SELECT id FROM products LIMIT 1');
  return fallbackRes.rows[0]?.id || null;
}

async function executeMigrationPipeline() {
  console.log("==================================================");
  console.log("GARAGEKINGS FIREBASE RECEIPTS MIGRATION RUNNER V2");
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
    VALUES ('Started', 'Firebase Receipts Migration Script V2')
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
        
        // Clean phone for guest email mapping
        const cleanPhonePart = phone.replace(/[^0-9]/g, '');
        const emailClean = `${cleanPhonePart || fbDoc.id}@guest.garagekings.in`.toLowerCase();

        let customerId;
        const custCheck = await pgClient.query(
          'SELECT id FROM customers WHERE email = $1',
          [emailClean]
        );

        if (custCheck.rows.length > 0) {
          customerId = custCheck.rows[0].id;
        } else {
          const insertCust = await pgClient.query(`
            INSERT INTO customers (full_name, phone, instagram, address, email, city)
            VALUES ($1, $2, $3, $4, $5, 'Unknown')
            RETURNING id;
          `, [customerName, phone, instagram, address, emailClean]);
          customerId = insertCust.rows[0].id;
          report.customersCreated++;
        }

        // C. Resolve User ID
        let userId;
        const userCheck = await pgClient.query('SELECT id FROM users WHERE email = $1', [emailClean]);
        if (userCheck.rows.length > 0) {
          userId = userCheck.rows[0].id;
        } else {
          const userRes = await pgClient.query(`
            INSERT INTO users (email, role, cognito_sub)
            VALUES ($1, 'Viewer', $2)
            RETURNING id;
          `, [emailClean, `guest_${customerId}`]);
          userId = userRes.rows[0].id;
        }

        // D. Parse pricing & amount calculations
        const formatType = receipt.formatType || 'standard';
        const taxPercent = Number(receipt.taxPercent || 0);
        const taxAmount = Number(receipt.taxAmount || 0);
        const shippingCharges = Number(receipt.shippingCharges || 0);
        const rawTotalAmount = Number(receipt.totalAmount || 0);
        const pendingBalance = Number(receipt.pendingBalance || 0);
        
        let advancePaid = 0;
        let totalAmount = 0;

        if (formatType === 'prebooking' || formatType === 'pre_order') {
          // Prebooking order: Firestore totalAmount holds the prebooking deposit/advance paid.
          // The full total price of the backing order is advance paid + pending balance.
          advancePaid = rawTotalAmount;
          totalAmount = advancePaid + pendingBalance;
        } else {
          // Standard order: Firestore totalAmount is the full total price.
          totalAmount = rawTotalAmount;
          advancePaid = totalAmount - pendingBalance;
        }

        const footerNote = receipt.footerNote || null;
        const createdAt = receipt.createdAt ? new Date(receipt.createdAt) : new Date();

        // E. Insert Backing Order in Postgres
        let dbStatus = 'Confirmed';
        if (pendingBalance === 0) {
          dbStatus = 'Delivered';
        } else if (formatType === 'prebooking' || formatType === 'pre_order') {
          dbStatus = 'Confirmed'; // Pre-orders remain Confirmed until remaining balance is cleared
        }

        const bookingType = (formatType === 'prebooking' || formatType === 'pre_order') ? 'pre_order' : 'standard';

        const orderInsertQuery = `
          INSERT INTO orders (user_id, total_price, shipping_address, status, booking_type, advance_amount, remaining_amount, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
          RETURNING id;
        `;
        const orderRes = await pgClient.query(orderInsertQuery, [
          userId,
          totalAmount,
          `${address || 'No Address'} | Phone: ${phone}`,
          dbStatus,
          bookingType,
          advancePaid,
          pendingBalance,
          createdAt
        ]);
        const orderId = orderRes.rows[0].id;
        report.ordersCreated++;

        // F. Insert Order Items and resolve Product IDs
        const items = receipt.items || [];
        for (const item of items) {
          const productId = await findProductId(pgClient, item.description);
          if (productId) {
            await pgClient.query(`
              INSERT INTO order_items (order_id, product_id, qty, price_at_purchase)
              VALUES ($1, $2, $3, $4);
            `, [
              orderId,
              productId,
              parseInt(item.qty || item.quantity || 1, 10),
              Number(item.amount || 0)
            ]);
          }
        }

        // G. Insert Receipt linked to backing order via order_id
        const pdfUrl = receipt.pdfUrl || `https://gk-public-assets.s3.ap-south-1.amazonaws.com/receipts/${receiptNumber}.pdf`;
        
        const receiptInsertQuery = `
          INSERT INTO receipts (
            receipt_number, customer_id, format_type, tax_percent, tax_amount, 
            shipping_charges, total_amount, advance_paid, pending_balance, footer_note, 
            customer_name, customer_phone, customer_instagram, customer_address, 
            created_at, order_id, pdf_url
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
          createdAt,
          orderId,
          pdfUrl
        ]);
        const receiptId = receiptRes.rows[0].id;

        // H. Insert Receipt Line Items
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

        // I. Create completed generation job entry
        await pgClient.query(`
          INSERT INTO receipt_generation_jobs (receipt_id, status, pdf_s3_url)
          VALUES ($1, 'Completed', $2);
        `, [receiptId, pdfUrl]);

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
  console.log(`Orders Created:       ${report.ordersCreated}`);
  console.log(`Failed Imports:       ${report.failedImports}`);
  console.log(`Duplicates Blocked:   ${report.duplicatesDetected}`);
  console.log(`Customers Created:    ${report.customersCreated}`);
  console.log(`Report CSV Exported:  ${reportPath}`);
  console.log("==================================================");
}

executeMigrationPipeline().catch(console.error);
