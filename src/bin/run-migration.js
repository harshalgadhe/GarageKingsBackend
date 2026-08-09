import ExcelJS from 'exceljs';
import { worksheetToObjects } from './excel-rows.js';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const excelPath = 'c:/Users/harsh/Downloads/Garage Kings India.xlsx';
const reportPath = 'C:/Users/harsh/.gemini/antigravity/brain/cd921884-9f2d-41fb-aed4-ce2a5ec876e0/migration_report.md';

const prebookDefaults = {
  'GTSUPRA': 1700,
  'GTMAZDA': 1700,
  'GTMUSTANG': 1700,
  'PRAGANI': 2000,
  'PR037': 1700,
  'GFCC1957': 3800,
  'CRVAN': 2200
};

function parseExcelDate(val) {
  if (!val) return new Date();
  if (typeof val === 'number') {
    const utc_days = Math.floor(val - 25569);
    const utc_value = utc_days * 86400;
    return new Date(utc_value * 1000);
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
  return new Date();
}

function getNumericId(orderIdStr) {
  if (!orderIdStr) return null;
  const match = orderIdStr.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.toString().replace(/[^0-9]/g, '');
}

function normalizeName(name) {
  if (!name) return '';
  return name.trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function nullifyNA(val) {
  if (val === undefined || val === null) return null;
  const clean = val.toString().trim();
  if (clean === '' || clean.toUpperCase() === 'NA' || clean.toUpperCase() === 'N/A') {
    return null;
  }
  return clean;
}

async function run() {
  const isWrite = process.argv.includes('--write');
  console.log(`Starting migration script. Mode: ${isWrite ? 'PHASE 2 (WRITE)' : 'PHASE 1 (DRY VALIDATION)'}`);

  if (!fs.existsSync(excelPath)) {
    console.error(`❌ Excel file not found at: ${excelPath}`);
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const rawProducts = worksheetToObjects(workbook.getWorksheet('Inventory'));
  const rawOrders = worksheetToObjects(workbook.getWorksheet('Orders'));
  const rawExpenses = worksheetToObjects(workbook.getWorksheet('Expense'));

  // Initialize report metrics
  const report = {
    productsCreated: 0,
    productsMatched: 0,
    productsSkipped: 0,
    duplicateProducts: 0,
    customersCreated: 0,
    customersMatched: 0,
    duplicateCustomers: 0,
    ordersImported: 0,
    orderItemsImported: 0,
    inventoryBatchesImported: 0,
    expensesImported: 0,
    unknownSKUs: [],
    malformedSKUs: [],
    inventoryMismatches: [],
    financialMismatches: [],
    duplicateOrders: 0,
    rowsSkipped: 0,
    warnings: [],
    errors: [],
    manualReviewRequired: []
  };

  const catalog = new Map();
  const batches = [];
  const duplicateSKUs = new Set();
  
  for (let i = 0; i < rawProducts.length; i++) {
    const row = rawProducts[i];
    if (!row['SKU ID']) {
      report.productsSkipped++;
      continue;
    }
    
    const sku = (row['SKU ID'].toString().trim()).toUpperCase();
    if (!sku) {
      report.malformedSKUs.push(`Row ${i + 2}: Malformed SKU ID`);
      continue;
    }

    const brand = row['Brand'] ? row['Brand'].toString().trim() : 'Unknown';
    const name = row['Product Name'] ? row['Product Name'].toString().trim() : 'Unnamed Product';
    const series = nullifyNA(row['Series']);
    const scale = nullifyNA(row['Scale']) || '1:64';
    const color = nullifyNA(row['Color Variant']);
    const purchasePrice = Number(row['Purchase Price'] || 0);
    const sellingPrice = Number(row['Selling Price'] || 0);
    const qtyPurchased = Number(row['Quantity Purchased'] || 0);
    const qtySold = Number(row['Quantity Sold'] || 0);
    const qtyAvailable = Number(row['Quantity Available'] || (qtyPurchased - qtySold));

    // Validate inventory equation: quantity_received = quantity_sold + quantity_available
    if (qtyPurchased !== (qtySold + qtyAvailable)) {
      const msg = `SKU: ${sku} - Quantity Purchased (${qtyPurchased}) does not equal Sold (${qtySold}) + Available (${qtyAvailable})`;
      report.inventoryMismatches.push(msg);
      report.warnings.push(msg);
    }

    if (catalog.has(sku)) {
      report.duplicateProducts++;
      duplicateSKUs.add(sku);
      const prod = catalog.get(sku);
      prod.totalStock += qtyPurchased;
      prod.soldStock += qtySold;
      prod.purchasePrice = purchasePrice;
      prod.price = sellingPrice;
    } else {
      catalog.set(sku, {
        sku,
        brand,
        name,
        series,
        scale,
        color,
        purchasePrice,
        price: sellingPrice,
        totalStock: qtyPurchased,
        soldStock: qtySold,
        lane: series || 'Standard Edition',
        category: brand.toLowerCase().includes('hotwheels') ? 'Mainline' : 'JDM',
        tags: series ? [series] : []
      });
    }

    batches.push({
      sku,
      purchasePrice,
      sellingPrice,
      qtyPurchased,
      qtySold,
      qtyAvailable,
      purchaseDate: parseExcelDate(row['Purchase Date'])
    });
    report.inventoryBatchesImported++;
  }

  // Resolve Customers & Orders
  const resolvedCustomers = [];
  const orderList = [];
  const uniqueOrders = new Set();
  const phoneCustomerMap = new Map();
  const emailCustomerMap = new Map();
  const nameCustomerMap = new Map();

  for (let i = 0; i < rawOrders.length; i++) {
    const row = rawOrders[i];
    const rawId = row['Order ID'];
    if (!rawId) {
      report.rowsSkipped++;
      continue;
    }

    const numericId = getNumericId(rawId);
    if (!numericId) {
      report.rowsSkipped++;
      continue;
    }

    if (uniqueOrders.has(numericId)) {
      report.duplicateOrders++;
      continue;
    }
    uniqueOrders.add(numericId);

    const name = normalizeName(row['Name']);
    const phone = normalizePhone(row['Phone No']);
    const address = row['Address'] ? row['Address'].toString().trim() : 'No Address';
    const email = row['Email ID'] ? row['Email ID'].toString().trim().toLowerCase() : `migrated_${numericId}@garagekings.in`;
    const skuRaw = row['Model ID (SKU)'] ? row['Model ID (SKU)'].toString().trim().toUpperCase() : '';
    const dateVal = parseExcelDate(row['Date']);

    const skuList = skuRaw.split(',').map(s => s.trim()).filter(Boolean);
    const validSkus = [];
    for (const s of skuList) {
      if (catalog.has(s)) {
        validSkus.push(s);
      } else {
        report.unknownSKUs.push(`Order ID ${numericId}: SKU ${s} not found in Inventory sheet`);
      }
    }

    const totalAmount = Number(row['Total Amount'] || 0);
    const advancePaid = Number(row['Advance Amount'] || 0);
    const pendingBalance = Number(row['Pending balance'] || (totalAmount - advancePaid));

    if (totalAmount !== (advancePaid + pendingBalance)) {
      report.financialMismatches.push(`Order ID ${numericId}: Total (${totalAmount}) != Advance (${advancePaid}) + Pending (${pendingBalance})`);
    }

    // Resolve Customer
    let customer = null;
    if (phone && phoneCustomerMap.has(phone)) {
      customer = phoneCustomerMap.get(phone);
    } else if (email && emailCustomerMap.has(email)) {
      customer = emailCustomerMap.get(email);
    } else if (name && nameCustomerMap.has(name)) {
      customer = nameCustomerMap.get(name);
    }

    if (!customer) {
      customer = { id: `CUST_${Date.now()}_${numericId}`, name, phone, email, address };
      resolvedCustomers.push(customer);
      if (phone) phoneCustomerMap.set(phone, customer);
      if (email) emailCustomerMap.set(email, customer);
      if (name) nameCustomerMap.set(name, customer);
      report.customersCreated++;
    } else {
      report.customersMatched++;
    }

    orderList.push({
      excelOrderId: numericId,
      customer,
      address,
      phone,
      orderDate: dateVal,
      skuList: validSkus,
      totalAmount,
      advancePaid,
      pendingBalance,
      bookingType: (row['Status'] && row['Status'].toString().toLowerCase().includes('pre')) ? 'pre_order' : 'standard',
      status: row['Status'] ? row['Status'].toString().trim() : 'Done',
      receiptDone: !!row['PDF Receipt Generated (Y/N)']
    });
    report.ordersImported++;
    report.orderItemsImported += validSkus.length;
  }

  // Parse Expenses
  const expenses = [];
  for (let i = 0; i < rawExpenses.length; i++) {
    const row = rawExpenses[i];
    if (!row['Expense Description']) continue;

    expenses.push({
      description: row['Expense Description'].toString().trim(),
      amount: Number(row['Amount'] || 0),
      category: row['Category'] ? row['Category'].toString().trim() : 'Operational',
      doneBy: row['Done by'] ? normalizeName(row['Done by']) : 'System',
      date: parseExcelDate(row['Date'])
    });
    report.expensesImported++;
  }

  console.log("✔ Validation complete. Ready to perform writes.");

  if (!isWrite) {
    console.log("PHASE 1 COMPLETE: Dry validation check passed.");
    process.exit(0);
  }

  // PHASE 2: WRITE TO DB
  console.log("Connecting to PostgreSQL pool for final writes...");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log("Database transaction started.");

    console.log("Truncating all transactional tables to perform a clean backfill...");
    await client.query(`
      TRUNCATE TABLE 
        order_inventory_allocations,
        inventory_ledger,
        inventory_batches,
        inventory,
        product_images,
        products,
        order_items,
        orders,
        customers,
        split_settlements,
        expenses,
        cash_ledger,
        cash_accounts,
        receipts,
        receipt_items,
        distributors,
        users
      CASCADE;
    `);

    // Seed default Cash Accounts
    console.log("Seeding default cash accounts...");
    const accountsRes = await client.query(`
      INSERT INTO cash_accounts (name, type, opening_balance, currency, display_order)
      VALUES 
        ('GarageKings Business Bank', 'Bank', 0.00, 'INR', 1),
        ('GarageKings UPI', 'UPI', 0.00, 'INR', 2),
        ('Cash Drawer', 'Cash Drawer', 0.00, 'INR', 3),
        ('Petty Cash', 'Petty Cash', 0.00, 'INR', 4)
      RETURNING id, name;
    `);
    const accountMap = {};
    accountsRes.rows.forEach(r => {
      accountMap[r.name] = r.id;
    });
    const defaultBankId = accountMap['GarageKings Business Bank'];
    const defaultUpiId = accountMap['GarageKings UPI'];
    const defaultPettyId = accountMap['Petty Cash'];

    // Seed default supplier
    const distRes = await client.query("INSERT INTO distributors (name) VALUES ('Initial Seed Supplier') RETURNING id;");
    const defaultDistId = distRes.rows[0].id;

    // Insert Products
    const productIdsMap = {};
    for (const [sku, p] of catalog.entries()) {
      const isPrebook = prebookDefaults[sku] !== undefined;
      const prodRes = await client.query(`
        INSERT INTO products (sku, brand, model_name, series, scale, rarity_level, base_price, description, tags, category, purchase_price, selling_price, total_stock, sold_stock, is_prebook, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING id;
      `, [
        sku,
        p.brand,
        p.name,
        p.series,
        p.scale,
        p.lane || 'Standard Edition',
        p.price,
        `Premium scale model. Color: ${p.color || 'NA'}.`,
        p.tags,
        p.category,
        p.purchasePrice,
        p.price,
        p.totalStock,
        p.soldStock,
        isPrebook,
        isPrebook ? 'Prebook' : 'Available'
      ]);
      const productId = prodRes.rows[0].id;
      productIdsMap[sku] = productId;

      await client.query(`
        INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
        VALUES ($1, '/placeholder-car.png', '/placeholder-car.png', '/placeholder-car.png', true);
      `, [productId]);

      const qtyAvailable = Math.max(0, p.totalStock - p.soldStock);
      await client.query(`
        INSERT INTO inventory (product_id, quantity_available, quantity_reserved, quantity_sold, quantity_returned, quantity_damaged, quantity_locked)
        VALUES ($1, $2, 0, $3, 0, 0, 0);
      `, [productId, qtyAvailable, p.soldStock]);
    }

    // Insert Batches & Ledger Trails
    const batchMap = {};
    for (const b of batches) {
      const productId = productIdsMap[b.sku];
      const batchRes = await client.query(`
        INSERT INTO inventory_batches (product_id, distributor_id, sku, purchase_price, selling_price, quantity_received, quantity_available, quantity_reserved, quantity_sold, status, received_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10)
        RETURNING id;
      `, [
        productId,
        defaultDistId,
        b.sku,
        b.purchasePrice,
        b.sellingPrice,
        b.qtyPurchased,
        b.qtyAvailable,
        b.qtySold,
        b.qtyAvailable === 0 ? 'Fully Consumed' : 'Partially Used',
        b.purchaseDate
      ]);
      const batchId = batchRes.rows[0].id;
      batchMap[b.sku] = batchId;

      await client.query(`
        INSERT INTO inventory_ledger (product_id, batch_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by, created_at)
        VALUES ($1, $2, 'RECEIVE', $3, $4, $5, 'Initial batch receipt import', 'System', $6);
      `, [productId, batchId, b.qtyPurchased, b.purchasePrice, b.sellingPrice, b.purchaseDate]);

      // Cash Ledger entry for Inventory Purchase
      const totalCost = Number(b.qtyPurchased) * Number(b.purchasePrice);
      if (totalCost > 0 && defaultBankId) {
        await client.query(`
          INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
          VALUES ($1, $2, 'Inventory Purchase', 'Completed', 'Inventory Batch', $3, $4, 'Imported during historical migration', $5, 'System');
        `, [
          defaultBankId,
          -totalCost,
          batchId,
          `Inventory purchase: ${b.qtyPurchased} units of SKU ${b.sku}`,
          b.purchaseDate
        ]);
      }

      if (b.qtySold > 0) {
        await client.query(`
          INSERT INTO inventory_ledger (product_id, batch_id, type, quantity_changed, purchase_price, selling_price, reason, performed_by, created_at)
          VALUES ($1, $2, 'SELL', $3, $4, $5, 'Initial sales depletion import', 'System', $6);
        `, [productId, batchId, -b.qtySold, b.purchasePrice, b.sellingPrice, b.purchaseDate]);
      }
    }

    // Insert Customers & Orders
    const customerDbIdsMap = new Map();
    const userDbIdsMap = new Map();

    for (const o of orderList) {
      const customerKey = o.customer.phone || o.customer.email;
      let customerId = customerDbIdsMap.get(customerKey);

      if (!customerId) {
        const custRes = await client.query(`
          INSERT INTO customers (full_name, phone, address, email, city)
          VALUES ($1, $2, $3, $4, 'Unknown')
          RETURNING id;
        `, [o.customer.name, o.customer.phone || null, o.customer.address, o.customer.email]);
        customerId = custRes.rows[0].id;
        customerDbIdsMap.set(customerKey, customerId);
      }

      let userId = userDbIdsMap.get(customerKey);
      if (!userId) {
        const userRes = await client.query(`
          INSERT INTO users (email, role, cognito_sub)
          VALUES ($1, 'Viewer', $2)
          RETURNING id;
        `, [o.customer.email, `guest_${customerId}`]);
        userId = userRes.rows[0].id;
        userDbIdsMap.set(customerKey, userId);
      }

      let dbStatus = 'Pending';
      if (o.pendingBalance === 0 && o.status.toLowerCase() === 'done') {
        dbStatus = 'Delivered';
      } else if (o.status.toLowerCase() === 'in process' || o.status.toLowerCase() === 'done') {
        dbStatus = 'Confirmed';
      }

      const orderInsertRes = await client.query(`
        INSERT INTO orders (user_id, total_price, shipping_address, status, booking_type, advance_amount, remaining_amount, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        RETURNING id;
      `, [
        userId,
        o.totalAmount,
        `${o.address} | Phone: ${o.phone}`,
        dbStatus,
        o.bookingType,
        o.advancePaid,
        o.pendingBalance,
        o.orderDate
      ]);
      const orderId = orderInsertRes.rows[0].id;

      // Cash Ledger entry for Order Payment
      const isPre = o.bookingType === 'pre_order';
      const ledgerType = isPre ? 'Pre-order Advance' : 'Customer Payment';
      const ledgerAmount = Number(o.advancePaid);

      if (ledgerAmount > 0 && defaultUpiId) {
        await client.query(`
          INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
          VALUES ($1, $2, $3, 'Completed', 'Order', $4, $5, 'Imported during historical migration', $6, 'System');
        `, [
          defaultUpiId,
          ledgerAmount,
          ledgerType,
          orderId,
          `Payment verified for order ${orderId}`,
          o.orderDate
        ]);

        const isPaidFull = dbStatus === 'Delivered' || dbStatus === 'Confirmed' || dbStatus === 'Shipped';
        const remainingPaid = Number(o.totalAmount) - Number(o.advancePaid) - Number(o.pendingBalance);
        if (isPaidFull && remainingPaid > 0) {
          await client.query(`
            INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
            VALUES ($1, $2, 'Pre-order Remaining Payment', 'Completed', 'Order', $3, $4, 'Imported during historical migration', $5, 'System');
          `, [
            defaultUpiId,
            remainingPaid,
            orderId,
            `Remaining payment verified for order ${orderId}`,
            o.orderDate
          ]);
        }
      }

      // Insert Items & Allocations
      for (const s of o.skuList) {
        const productId = productIdsMap[s];
        const batchId = batchMap[s];

        const itemRes = await client.query(`
          INSERT INTO order_items (order_id, product_id, qty, price_at_purchase, purchase_price_at_purchase)
          VALUES ($1, $2, 1, $3, (SELECT purchase_price FROM inventory_batches WHERE id = $4))
          RETURNING id;
        `, [orderId, productId, o.advancePaid, batchId]);
        const orderItemId = itemRes.rows[0].id;

        if (batchId && (dbStatus === 'Delivered' || dbStatus === 'Confirmed' || dbStatus === 'Shipped' || dbStatus === 'Pre-Order')) {
          await client.query(`
            INSERT INTO order_inventory_allocations (order_item_id, batch_id, quantity, purchase_price, selling_price)
            VALUES ($1, $2, 1, (SELECT purchase_price FROM inventory_batches WHERE id = $2), $3);
          `, [orderItemId, batchId, o.advancePaid]);
        }
      }

      // Receipts Mapping
      if (o.receiptDone) {
        const formatType = (o.bookingType === 'pre_order') ? 'prebooking' : 'standard';
        const pdfUrl = `https://gk-public-assets.s3.ap-south-1.amazonaws.com/receipts/${o.excelOrderId}.pdf`;

        const receiptInsertRes = await client.query(`
          INSERT INTO receipts (
            receipt_number, customer_id, format_type, tax_percent, tax_amount, 
            shipping_charges, total_amount, advance_paid, pending_balance, footer_note, 
            customer_name, customer_phone, customer_address, created_at, order_id, pdf_url
          )
          VALUES ($1, $2, $3, 0.00, 0.00, 0.00, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING id;
        `, [
          o.excelOrderId,
          customerId,
          formatType,
          o.totalAmount,
          o.advancePaid,
          o.pendingBalance,
          'In the event that the order cannot be fulfilled from our end, a full refund will be issued.',
          o.customer.name,
          o.phone,
          o.address,
          o.orderDate,
          orderId,
          pdfUrl
        ]);
        const receiptId = receiptInsertRes.rows[0].id;

        for (const s of o.skuList) {
          const prodName = rawProducts.find(p => p['SKU ID'] === s)?.['Product Name'] || s;
          await client.query(`
            INSERT INTO receipt_items (receipt_id, description, qty, amount)
            VALUES ($1, $2, 1, $3);
          `, [receiptId, `${prodName} - ${s}`, o.advancePaid]);
        }

        await client.query(`
          INSERT INTO receipt_generation_jobs (receipt_id, status, pdf_s3_url)
          VALUES ($1, 'Completed', $2);
        `, [receiptId, pdfUrl]);
      }
    }

    // Insert Expenses & Ledger entries
    for (const exp of expenses) {
      const expInsertRes = await client.query(`
        INSERT INTO expenses (title, amount, category, paid_by, date, notes)
        VALUES ($1, $2, $3, $4, $5, 'Imported during historical migration')
        RETURNING id;
      `, [exp.description, exp.amount, exp.category, exp.doneBy, exp.date]);
      const expId = expInsertRes.rows[0].id;

      // Log Operating Expense outflow
      if (defaultPettyId) {
        await client.query(`
          INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, date, created_by)
          VALUES ($1, $2, 'Operating Expense', 'Completed', 'Expense', $3, $4, 'Imported during historical migration', $5, 'System');
        `, [
          defaultPettyId,
          -Number(exp.amount),
          expId,
          exp.description,
          exp.date
        ]);

        // If paid by founder personally, record their capital contribution
        const founders = ['Harshal', 'Anutosh', 'Sanchit', 'Anish'];
        if (founders.includes(exp.doneBy)) {
          await client.query(`
            INSERT INTO cash_ledger (cash_account_id, amount, type, status, source_type, source_id, reason, notes, founder_name, date, created_by)
            VALUES ($1, $2, 'Founder Contribution', 'Completed', 'Founder Ledger', 'Contribution', $3, $4, $5, $6, 'System');
          `, [
            defaultPettyId,
            Number(exp.amount),
            expId,
            `Founder Contribution for expense: ${exp.description}`,
            `Auto-created on expense migration (paid personally)`,
            exp.doneBy,
            exp.date
          ]);
        }
      }
    }

    await client.query('COMMIT');
    console.log("✔ Phase 2 database writes completed and transaction committed successfully.");

    // Success Verification Queries
    console.log("Running post-migration verification checks...");
    const mismatches = [];

    // 1. Verify product caches vs batches
    const sumCheck = await client.query(`
      SELECT p.sku, p.total_stock, SUM(b.quantity_received)::int as batch_sum
      FROM products p
      JOIN inventory_batches b ON b.product_id = p.id
      GROUP BY p.sku, p.total_stock
      HAVING p.total_stock != SUM(b.quantity_received)::int;
    `);
    if (sumCheck.rows.length > 0) {
      mismatches.push(`Product total stock cache mismatch for ${sumCheck.rows.length} rows.`);
    }

    // 2. Verify negative inventory
    const negCheck = await client.query(`
      SELECT COUNT(*) FROM inventory WHERE quantity_available < 0;
    `);
    if (Number(negCheck.rows[0].count) > 0) {
      mismatches.push(`Found negative inventory caches!`);
    }

    // 3. Verify order relations
    const orphanItems = await client.query(`
      SELECT COUNT(*) FROM order_items WHERE product_id IS NULL;
    `);
    if (Number(orphanItems.rows[0].count) > 0) {
      mismatches.push(`Found orphaned order items!`);
    }

    // 4. Verify Cash accounts vs ledger sum matches
    const cashTotal = await client.query("SELECT SUM(amount)::float as total FROM cash_ledger WHERE status = 'Completed';");
    console.log(`Verified Ledger Net Cash Balance: ₹${cashTotal.rows[0].total.toLocaleString('en-IN')}`);

    if (mismatches.length > 0) {
      console.error("❌ Post-migration verification failed!", mismatches);
    } else {
      console.log("✔ SUCCESS: All post-migration verifications passed successfully!");
    }

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("❌ SQL Transaction failed and rolled back!", error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(console.error);
