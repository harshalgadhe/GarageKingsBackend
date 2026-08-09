import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import ExcelJS from 'exceljs';
import { worksheetToObjects } from './src/bin/excel-rows.js';
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
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false
  });
  await client.connect();
  console.log("Connected to PostgreSQL database.");

  // Truncate all tables CASCADE to ensure clean state
  console.log("Truncating all database tables...");
  const resTables = await client.query(`
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public';
  `);
  const tables = resTables.rows.map(r => `"${r.tablename}"`);
  if (tables.length > 0) {
    await client.query(`TRUNCATE TABLE ${tables.join(', ')} CASCADE;`);
  }
  console.log("Database tables truncated successfully.");

  // Drop NOT NULL constraints on products.sku and products.base_price for master-variant compatibility
  await client.query(`
    ALTER TABLE products ALTER COLUMN sku DROP NOT NULL;
    ALTER TABLE products ALTER COLUMN base_price DROP NOT NULL;
    ALTER TABLE inventory_batches ALTER COLUMN product_id DROP NOT NULL;
    ALTER TABLE order_items ALTER COLUMN product_id DROP NOT NULL;
    ALTER TABLE supplier_purchase_items ALTER COLUMN product_id DROP NOT NULL;
    ALTER TABLE supplier_purchase_receipt_items ALTER COLUMN product_id DROP NOT NULL;
    ALTER TABLE inventory_ledger ALTER COLUMN product_id DROP NOT NULL;
    ALTER TABLE reservations ALTER COLUMN product_id DROP NOT NULL;
  `);

  // Seed default casing types
  await client.query(`
    INSERT INTO casing_types (name, display_name, description)
    VALUES 
      ('BOX', 'Standard Boxed Casing', 'Standard packaging'),
      ('BLISTER', 'Blister Card Casing', 'Blister backing packaging'),
      ('ACRYLIC', 'Premium Acrylic Case Casing', 'Premium acrylic case display')
    ON CONFLICT (name) DO NOTHING;
  `);

  const casingRes = await client.query("SELECT id, name, display_name FROM casing_types;");
  const casingMap = new Map(casingRes.rows.map(c => [c.name.toUpperCase(), c.id]));
  const casingDisplayMap = new Map(casingRes.rows.map(c => [c.name.toUpperCase(), c.display_name]));

  // Seed default supplier
  const supInsert = await client.query(
    "INSERT INTO suppliers (name, contact_email, contact_phone, address) VALUES ($1, $2, $3, $4) RETURNING id",
    ['Diecast Distributors India', 'contact@ddi.com', '+91 99999 88888', 'Mumbai, India']
  );
  const supplierId = supInsert.rows[0].id;

  // Seed default company cash account
  const cashAccInsert = await client.query(`
    INSERT INTO cash_accounts (name, type, currency, opening_balance)
    VALUES ($1, $2, $3, $4)
    RETURNING id;
  `, ['Company Bank Account', 'Bank', 'INR', 0.00]);
  const cashAccountId = cashAccInsert.rows[0].id;

  // Seed admin user
  await client.query(`
    INSERT INTO users (email, role, cognito_sub)
    VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET role = 'Admin';
  `, ['sanchitjain0801@gmail.com', 'Admin', 'admin-sanchit']);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);

  // Initialize Report Variables
  let productsImported = 0;
  let variantsCreated = 0;
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
  const rawInventory = worksheetToObjects(workbook.getWorksheet('Inventory'));

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

    // Parse casing type from Product Name
    let parsedCasing = 'BOX';
    const nameLower = name.toLowerCase();
    if (nameLower.includes('blister')) {
      parsedCasing = 'BLISTER';
    } else if (nameLower.includes('acrylic')) {
      parsedCasing = 'ACRYLIC';
    }
    const casingTypeId = casingMap.get(parsedCasing);

    // Check if product already exists under brand and model name
    const normalizedModelName = name
      .replace(/\s+(blister|box|acrylic|casing)\b/gi, '')
      .replace(/\b(blister|box|acrylic|casing)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    let productId;
    const existingRes = await client.query(`
      SELECT id FROM products 
      WHERE LOWER(brand) = LOWER($1) AND LOWER(model_name) = LOWER($2)
      LIMIT 1
    `, [brand, normalizedModelName]);

    if (existingRes.rows.length > 0) {
      productId = existingRes.rows[0].id;
    } else {
      const newProd = await client.query(`
        INSERT INTO products (brand, model_name, series, scale, status, description)
        VALUES ($1, $2, $3, $4, 'Published', $5)
        RETURNING id;
      `, [brand, normalizedModelName, series, scale, `Color Variant: ${color}`]);
      productId = newProd.rows[0].id;
      productsImported++;
    }

    // Insert or update Variant
    const variantSku = `${sku}-${parsedCasing}`;
    const variantName = `${normalizedModelName} (${casingDisplayMap.get(parsedCasing)})`;

    let variantId;
    const varRes = await client.query(`
      SELECT id FROM product_variants 
      WHERE product_id = $1 AND casing_type_id = $2
      LIMIT 1
    `, [productId, casingTypeId]);

    if (varRes.rows.length > 0) {
      variantId = varRes.rows[0].id;
      await client.query(`
        UPDATE product_variants 
        SET total_stock = total_stock + $1, sold_stock = sold_stock + $2, updated_at = NOW()
        WHERE id = $3;
      `, [quantityPurchased, quantitySold, variantId]);
    } else {
      const newVar = await client.query(`
        INSERT INTO product_variants (product_id, casing_type_id, sku, name, selling_price, status, sales_status, total_stock, sold_stock)
        VALUES ($1, $2, $3, $4, $5, 'Published', $6, $7, $8)
        RETURNING id;
      `, [productId, casingTypeId, variantSku, variantName, sellingPrice, isPrebook ? 'Preorder' : 'Available', quantityPurchased, quantitySold]);
      variantId = newVar.rows[0].id;
      variantsCreated++;
    }

    // Seed catalog price
    await client.query(`
      INSERT INTO catalog_prices (variant_id, selling_price, reason, created_by)
      VALUES ($1, $2, 'Historical data import', 'Import Pipeline');
    `, [variantId, sellingPrice]);

    // Insert Inventory Batch
    const batchInsert = await client.query(`
      INSERT INTO inventory_batches (variant_id, sku, purchase_price, quantity_received, quantity_available, quantity_sold, supplier_id, received_at, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id;
    `, [variantId, variantSku, purchasePrice, quantityPurchased, currentStock, quantitySold, supplierId, purchaseDate, currentStock === 0 ? 'Fully Consumed' : 'Open']);
    const batchId = batchInsert.rows[0].id;

    // Create Initial FIFO transaction ledger
    await client.query(`
      INSERT INTO inventory_ledger (variant_id, batch_id, type, quantity_changed, purchase_price, reason, performed_by)
      VALUES ($1, $2, 'INITIAL_INFLOW', $3, $4, $5, $6);
    `, [variantId, batchId, quantityPurchased, purchasePrice, 'Historical batch import', 'Import Pipeline']);

    batchesCreated++;
  }
  console.log(`Successfully synced details for ${productsImported} products, ${variantsCreated} variants, and ${batchesCreated} batches.`);

  // ==========================================
  // 2. IMPORT CUSTOMERS & ORDERS (Orders)
  // ==========================================
  console.log("\n--- Importing Orders Sheet ---");
  const rawOrders = worksheetToObjects(workbook.getWorksheet('Orders'));

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
    const paidTo = String(row['Paid To'] || 'Company Account').trim();

    // Map status
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
    } else if (rawStatus === 'pending receipt') {
      status = 'Verification Pending';
    }

    const bookingType = orderType.includes('booking') ? 'pre_order' : 'standard';
    const advanceAmount = bookingType === 'pre_order' ? amountPaid : 0;
    const remainingAmount = 0;

    // Derived unique email
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

    // Find or create customer
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
      // Find matching variant (fallback from standard SKU to BOX variant)
      const varRes = await client.query(`
        SELECT pv.id, pv.selling_price, pv.name, pv.sku, p.brand, ct.display_name as casing_display
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        JOIN casing_types ct ON ct.id = pv.casing_type_id
        WHERE pv.sku = $1 OR pv.sku = $2
        LIMIT 1;
      `, [itemSku, `${itemSku}-BOX`]);

      if (varRes.rows.length > 0) {
        const v = varRes.rows[0];
        await client.query(`
          INSERT INTO order_items (order_id, variant_id, qty, price_at_purchase, variant_name_snapshot, sku_snapshot, brand_snapshot, casing_snapshot, manufacturer_snapshot)
          VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)
        `, [dbOrderId, v.id, v.selling_price || amountPaid, v.name, v.sku, v.brand, v.casing_display, v.brand]);
      } else {
        validationWarnings.push(`Order SKU reference not found: SKU ${itemSku} on Order ${orderId}`);
      }
    }

    // Add inflow payment to cash ledger
    if (amountPaid > 0) {
      await client.query(`
        INSERT INTO cash_ledger (cash_account_id, type, amount, source_type, source_id, created_by, reason, notes)
        VALUES ($1, 'Sales Revenue', $2, 'Order', $3, 'System', $4, $5);
      `, [cashAccountId, amountPaid, dbOrderId, `Inflow for order: ${orderId}`, `Payment via: ${paidTo}`]);
    }

    ordersImported++;
  }
  console.log(`Successfully synced ${ordersImported} orders.`);

  // ==========================================
  // 3. IMPORT EXPENSES (Expense)
  // ==========================================
  console.log("\n--- Importing Expense Sheet ---");
  const rawExpenses = worksheetToObjects(workbook.getWorksheet('Expense'));

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
  console.log(`Variants Created:             ${variantsCreated}`);
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
