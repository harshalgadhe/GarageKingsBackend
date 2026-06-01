import pkg from 'pg';
const { Client } = pkg;
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
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

async function executeAuditValidation() {
  console.log("==================================================");
  console.log("GARAGEKINGS MIGRATION AUDIT & PARITY CALCULATOR");
  console.log("==================================================");

  // 1. Initialize Firestore & Postgres Client
  const fbApp = initializeApp(firebaseConfig);
  const fbDb = getFirestore(fbApp);

  const pgClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  await pgClient.connect();
  console.log("✔ Connected to Postgres. Commencing parity checks...");

  const auditReport = {
    checkedAt: new Date().toISOString(),
    firestoreCarsCount: 0,
    postgresProductsCount: 0,
    mismatches: [],
    financialChecks: {
      firestoreSum: 0,
      postgresSum: 0,
      variance: 0
    }
  };

  try {
    // A. Check Product Catalog Counts Parity
    const fbCarsSnapshot = await getDocs(collection(fbDb, 'cars'));
    auditReport.firestoreCarsCount = fbCarsSnapshot.size;

    const pgCountRes = await pgClient.query('SELECT COUNT(*) FROM products');
    auditReport.postgresProductsCount = parseInt(pgCountRes.rows[0].count, 10);

    console.log(`\nParity check counts - Firestore Cars: ${auditReport.firestoreCarsCount} | PostgreSQL Products: ${auditReport.postgresProductsCount}`);

    if (auditReport.firestoreCarsCount !== auditReport.postgresProductsCount) {
      console.warn("⚠️ Records mismatch detected in product counts!");
      auditReport.mismatches.push({
        type: 'RECORD_COUNT_MISMATCH',
        details: `Firestore count (${auditReport.firestoreCarsCount}) does not match PostgreSQL count (${auditReport.postgresProductsCount}).`
      });
    }

    // B. Calculate financial sum parity checks across billing models
    const fbReceiptsSnap = await getDocs(collection(fbDb, 'receipts'));
    fbReceiptsSnap.forEach(doc => {
      const data = doc.data();
      auditReport.financialChecks.firestoreSum += Number(data.totalAmount || data.total || 0);
    });

    const pgSumRes = await pgClient.query('SELECT SUM(total_amount) FROM receipts');
    auditReport.financialChecks.postgresSum = parseFloat(pgSumRes.rows[0].sum || 0);

    const varianceVal = Math.abs(auditReport.financialChecks.firestoreSum - auditReport.financialChecks.postgresSum);
    auditReport.financialChecks.variance = varianceVal;

    console.log(`Financial sum check - Firestore Sum: ₹${auditReport.financialChecks.firestoreSum.toFixed(2)} | PG Sum: ₹${auditReport.financialChecks.postgresSum.toFixed(2)}`);

    if (varianceVal > 0.01) {
      console.error(`❌ DISCREPANCY: Financial variance detected! (Diff: ₹${varianceVal.toFixed(2)})`);
      auditReport.mismatches.push({
        type: 'FINANCIAL_SUM_DISCREPANCY',
        details: `Sum mismatch of ₹${varianceVal.toFixed(2)} detected between Firestore and PostgreSQL.`
      });
    } else {
      console.log("✔ Parity math validation passed successfully.");
    }

    // 3. Compile validation reports output
    const reportPath = path.join(process.cwd(), 'migration_validation_audit.json');
    fs.writeFileSync(reportPath, JSON.stringify(auditReport, null, 2), 'utf8');
    
    console.log("==================================================");
    console.log("PARITY VALIDATION COMPLETE");
    console.log(`Mismatches Found:    ${auditReport.mismatches.length}`);
    console.log(`Validation Log:      ${reportPath}`);
    console.log("==================================================");

  } catch (error) {
    console.error("Critical error in validation script:", error);
  } finally {
    await pgClient.end();
  }
}

executeAuditValidation().catch(console.error);
