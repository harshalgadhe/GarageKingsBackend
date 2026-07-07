import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import XLSX from 'xlsx';
import https from 'https';
import fs from 'fs';

dotenv.config();

const excelPath = 'c:/Users/harsh/Downloads/Garage Kings India.xlsx';
const spreadsheetUrl = 'https://docs.google.com/spreadsheets/d/1b-5B2gxGvSgUUe0l1mlIrvV07NYbLpkj9McMG8tRlfw/export?format=xlsx';

// Download spreadsheet from Google Sheets supporting redirects
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download sheet: Status ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function parseExcelDate(val) {
  if (!val) return new Date();
  if (typeof val === 'number') {
    return new Date(Math.round((val - 25569) * 86400 * 1000));
  }
  if (typeof val === 'string') {
    const parts = val.trim().split('/');
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2], 10);
      return new Date(year, month, day);
    }
    return new Date(val);
  }
  return new Date(val);
}

async function main() {
  console.log("Downloading spreadsheet from Google Sheets...");
  try {
    await downloadFile(spreadsheetUrl, excelPath);
    console.log(`Saved spreadsheet to ${excelPath}`);
  } catch (err) {
    console.warn(`Could not download live sheet (${err.message}). Using local fallback if available.`);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
  await client.connect();
  console.log("Connected to PostgreSQL database.");

  // Truncate non-preserved transactional data
  console.log("Truncating transactional database tables...");
  await client.query(`
    TRUNCATE TABLE 
      cash_ledger,
      supplier_payments,
      supplier_purchase_receipt_items,
      supplier_purchase_receipts,
      supplier_purchase_items,
      supplier_purchases,
      suppliers,
      order_inventory_allocations,
      order_items,
      orders,
      inventory_ledger,
      inventory_snapshots,
      inventory_cycle_count_items,
      inventory_cycle_counts,
      inventory_batches,
      inventory,
      product_images,
      products,
      expenses,
      split_settlements,
      customers,
      system_notifications,
      audit_logs
    CASCADE;
  `);
  console.log("Transactional tables truncated successfully.");

  const workbook = XLSX.readFile(excelPath);

  // Initialize Report Variables
  let productsImported = 0;
  let batchesCreated = 0;
  let ordersImported = 0;
  let expensesImported = 0;
  let skippedRows = 0;
  let duplicateDetections = 0;
  const validationWarnings = [];

  // ==========================================
  // 1. IMPORT PRODUCTS & BATCHES (Inventory)
  // ==========================================
  console.log("\n--- Importing Inventory Sheet ---");
  const invSheet = workbook.Sheets['Inventory'];
  const rawInventory = XLSX.utils.sheet_to_json(invSheet);

  // Create default supplier
  const supInsert = await client.query(
    "INSERT INTO suppliers (name, contact_email, contact_phone, address) VALUES ($1, $2, $3, $4) RETURNING id",
    ['Diecast Distributors India', 'contact@ddi.com', '+91 99999 88888', 'Mumbai, India']
  );
  const supplierId = supInsert.rows[0].id;

  const skuMap = new Set();

  for (const row of rawInventory) {
    const rawSku = row['SKU ID'];
    if (!rawSku) {
      skippedRows++;
      continue;
    }
    const sku = String(rawSku).trim();
    if (skuMap.has(sku)) {
      duplicateDetections++;
      validationWarnings.push(`Duplicate product SKU skipped: ${sku}`);
      continue;
    }
    skuMap.add(sku);

    const brand = String(row['Brand'] || 'Unknown').trim();
    const name = String(row['Product Name'] || 'Unnamed Product').trim();
    const series = String(row['Series'] || 'NA').trim();
    const scale = String(row['Scale'] || '1:64').trim();
    const color = String(row['Color Variant'] || 'NA').trim();
    
    const purchaseDate = parseExcelDate(row['Purchase Date']);
    const purchasePrice = parseFloat(row['Purchase Price']) || 0;
    const quantityPurchased = parseInt(row['Quantity Purchased'], 10) || 0;
    const quantitySold = parseInt(row['Quantity Sold'], 10) || 0;
    const currentStock = parseInt(row['Current Stock'], 10) || 0;
    const sellingPrice = parseFloat(row['Selling Price']) || 0;
    const prebookingDetails = row['Pre- Booking Details'];
    const isPrebook = !!(prebookingDetails && String(prebookingDetails).trim());

    // Parse casing type from name
    let parsedCasing = 'box';
    const nameLower = name.toLowerCase();
    if (nameLower.includes('blister')) {
      parsedCasing = 'blister';
    } else if (nameLower.includes('acrylic')) {
      parsedCasing = 'acrylic casing';
    }

    // Insert product catalog entry (setting status to Published for immediate visibility)
    const newProd = await client.query(`
      INSERT INTO products (brand, model_name, series, scale, sku, base_price, purchase_price, selling_price, total_stock, status, is_prebook, description, casing_types)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Published', $10, $11, $12)
      RETURNING id;
    `, [brand, name, series, scale, sku, sellingPrice, purchasePrice, sellingPrice, quantityPurchased, isPrebook, `Color Variant: ${color}`, [parsedCasing]]);
    const productId = newProd.rows[0].id;

    // Insert inventory batch
    await client.query(`
      INSERT INTO inventory_batches (product_id, sku, purchase_price, selling_price, quantity_received, quantity_available, quantity_sold, supplier_id, received_at, casing_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [productId, sku, purchasePrice, sellingPrice, quantityPurchased, currentStock, quantitySold, supplierId, purchaseDate, parsedCasing]);

    // Insert inventory cache
    await client.query(`
      INSERT INTO inventory (product_id, quantity_available, quantity_sold, quantity_reserved, quantity_damaged)
      VALUES ($1, $2, $3, 0, 0)
    `, [productId, currentStock, quantitySold]);

    productsImported++;
    batchesCreated++;
  }

  // ==========================================
  // 2. IMPORT CUSTOMERS & ORDERS (Orders)
  // ==========================================
  console.log("\n--- Importing Orders Sheet ---");
  const ordersSheet = workbook.Sheets['Orders'];
  const rawOrders = XLSX.utils.sheet_to_json(ordersSheet);

  const orderIdMap = new Set();

  for (const row of rawOrders) {
    const rawOrderId = row['Order ID'];
    if (!rawOrderId) {
      skippedRows++;
      continue;
    }
    const orderId = String(rawOrderId).trim();
    if (orderIdMap.has(orderId)) {
      duplicateDetections++;
      validationWarnings.push(`Duplicate order ID skipped: ${orderId}`);
      continue;
    }
    orderIdMap.add(orderId);

    const customerName = String(row['Customer Name '] || row['Customer Name'] || 'Walk-in Customer').trim();
    const phone = String(row['Phone Number'] || 'NA').trim();
    const address = String(row['Address'] || 'NA').trim();
    const skuListString = String(row['SUK IDs'] || '').trim();
    const amountPaid = parseFloat(row['Amount Paid']) || 0;
    const rawStatus = String(row['Status'] || 'Pending').trim().toLowerCase();
    const orderDate = parseExcelDate(row['Date']);
    const orderType = String(row['Type'] || 'Order').trim().toLowerCase();

    // Historical status mapping
    let status = 'Pending';
    if (rawStatus === 'done' || rawStatus === 'shipped') {
      status = 'Shipped';
    } else if (rawStatus === 'delivered') {
      status = 'Delivered';
    } else if (rawStatus === 'paid' || rawStatus === 'complete') {
      status = 'Paid';
    } else if (rawStatus === 'pending') {
      status = 'Pending';
    } else if (rawStatus === 'cancelled') {
      status = 'Cancelled';
    } else if (rawStatus === 'pending receipt' || rawStatus === 'verification pending') {
      status = 'Verification Pending';
    }

    const bookingType = orderType.includes('booking') ? 'pre_order' : 'standard';
    const advanceAmount = bookingType === 'pre_order' ? amountPaid : 0;
    const remainingAmount = 0;

    // Derived unique email to avoid duplicates
    const emailSafe = customerName.replace(/\s+/g, '').toLowerCase() + (phone !== 'NA' ? `.${phone.slice(-4)}` : '') + '@garagekings.in';

    // Find or create user
    let userId = null;
    const userRes = await client.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [emailSafe]);
    if (userRes.rows.length > 0) {
      userId = userRes.rows[0].id;
    } else {
      const newUser = await client.query(
        "INSERT INTO users (email, role, cognito_sub) VALUES ($1, $2, $3) RETURNING id",
        [emailSafe, 'Viewer', 'import-' + Math.random().toString(36).substr(2, 9)]
      );
      userId = newUser.rows[0].id;
    }

    // Find or create customer CRM record
    const custRes = await client.query("SELECT id FROM customers WHERE email = $1 LIMIT 1", [emailSafe]);
    if (custRes.rows.length === 0) {
      await client.query(
        "INSERT INTO customers (full_name, phone, address, email) VALUES ($1, $2, $3, $4)",
        [customerName, phone, address, emailSafe]
      );
    }

    // Insert Order record
    const orderInsert = await client.query(`
      INSERT INTO orders (user_id, status, total_price, shipping_address, booking_type, advance_amount, remaining_amount, idempotency_key, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id;
    `, [userId, status, amountPaid, address, bookingType, advanceAmount, remainingAmount, orderId, orderDate]);
    const dbOrderId = orderInsert.rows[0].id;

    // Parse product SKUs
    const skus = skuListString.split(',').map(s => s.trim()).filter(Boolean);
    for (const itemSku of skus) {
      const prodRes = await client.query("SELECT id, selling_price, purchase_price FROM products WHERE sku = $1 LIMIT 1", [itemSku]);
      if (prodRes.rows.length > 0) {
        const prod = prodRes.rows[0];
        await client.query(`
          INSERT INTO order_items (order_id, product_id, qty, price_at_purchase, purchase_price_at_purchase)
          VALUES ($1, $2, 1, $3, $4)
        `, [dbOrderId, prod.id, prod.selling_price || amountPaid, prod.purchase_price || 0]);
      } else {
        validationWarnings.push(`Order SKU reference not found: SKU ${itemSku} on Order ${orderId}`);
      }
    }

    ordersImported++;
  }

  // ==========================================
  // 3. IMPORT EXPENSES (Expense)
  // ==========================================
  console.log("\n--- Importing Expense Sheet ---");
  const expenseSheet = workbook.Sheets['Expense'];
  const rawExpenses = XLSX.utils.sheet_to_json(expenseSheet);

  // Fetch default cash account ID
  const accountRes = await client.query("SELECT id FROM cash_accounts WHERE type = 'Bank' LIMIT 1;");
  const cashAccountId = accountRes.rows[0]?.id;

  for (const row of rawExpenses) {
    const desc = row['Description'];
    if (!desc) {
      skippedRows++;
      continue;
    }
    
    const title = String(desc).trim();
    const paidBy = String(row['Done By'] || 'Harshal').trim();
    const amount = parseFloat(row['Amount']) || 0;

    const expInsert = await client.query(`
      INSERT INTO expenses (title, amount, category, paid_by, date, notes)
      VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
      RETURNING id;
    `, [title, amount, 'Stock Purchase', paidBy, 'Excel Import']);
    const expenseId = expInsert.rows[0].id;

    if (cashAccountId) {
      const outflowAmount = -Math.abs(amount);
      await client.query(`
        INSERT INTO cash_ledger (cash_account_id, type, amount, source_type, source_id, created_by, reason, notes)
        VALUES ($1, 'Operating Expense', $2, 'Expense', $3, $4, $5, $6);
      `, [cashAccountId, outflowAmount, expenseId, paidBy, `Outflow for expense: ${title}`, 'Excel Import']);
    }

    expensesImported++;
  }

  await client.end();

  // Print execution sync report
  console.log("\n==========================================");
  console.log("     DATABASE IMPORT METRICS REPORT");
  console.log("==========================================");
  console.log(`Products Imported:            ${productsImported}`);
  console.log(`Inventory Batches Created:    ${batchesCreated}`);
  console.log(`Orders Imported:              ${ordersImported}`);
  console.log(`Expenses Imported:            ${expensesImported}`);
  console.log(`Skipped Rows:                 ${skippedRows}`);
  console.log(`Duplicate Detections:         ${duplicateDetections}`);
  console.log(`Validation Warnings Count:    ${validationWarnings.length}`);
  if (validationWarnings.length > 0) {
    console.log("--- First 10 Warnings ---");
    validationWarnings.slice(0, 10).forEach(w => console.log(` - ${w}`));
  }
  console.log("==========================================");
  console.log("Sync Completed Successfully!");
}

main().catch(console.error);
