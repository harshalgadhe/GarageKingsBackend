import XLSX from 'xlsx';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const excelPath = 'c:/Users/harsh/Downloads/Garage Kings India.xlsx';

const prebookDefaults = {
  'GTSUPRA': 1700,
  'GTMAZDA': 1700,
  'GTMUSTANG': 1700,
  'PRPAGANI': 2000,
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

async function runImport() {
  console.log("==================================================");
  console.log("GARAGEKINGS EXCEL DATABASE REBUILDER");
  console.log(`Excel file: ${excelPath}`);
  console.log("==================================================");

  if (!fs.existsSync(excelPath)) {
    console.error(`❌ Excel file not found at: ${excelPath}`);
    process.exit(1);
  }

  // 1. Read Excel file sheets
  const workbook = XLSX.readFile(excelPath);
  const invSheet = workbook.Sheets['Inventory'];
  const ordSheet = workbook.Sheets['Orders'];
  const expSheet = workbook.Sheets['Expense'];

  const rawProducts = XLSX.utils.sheet_to_json(invSheet).filter(row => row['SKU ID'] && row['SKU ID'].toString().trim());
  const rawOrders = XLSX.utils.sheet_to_json(ordSheet).filter(row => row['Order ID'] && row['Order ID'].toString().trim());
  const rawExpenses = XLSX.utils.sheet_to_json(expSheet).filter(row => row['Description'] && row['Description'].toString().trim());

  console.log(`✔ Excel sheets parsed:`);
  console.log(`  - Products in Inventory: ${rawProducts.length}`);
  console.log(`  - Orders: ${rawOrders.length}`);
  console.log(`  - Expenses: ${rawExpenses.length}`);

  // 2. Connect to database
  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
  const pgClient = await pgPool.connect();
  console.log("✔ Connected to PostgreSQL database.");

  // 3. Cache existing pre-order price totals before resetting the database
  console.log("Caching historical pre-order pricing from current DB...");
  const dbPreorders = new Map();
  try {
    const dbRes = await pgClient.query(`
      SELECT 
        r.receipt_number as "orderId", 
        o.advance_amount as "advance", 
        o.remaining_amount as "remaining", 
        o.total_price as "total"
      FROM orders o
      JOIN receipts r ON r.order_id = o.id
      WHERE o.booking_type = 'pre_order'
    `);
    dbRes.rows.forEach(row => {
      const numId = getNumericId(row.orderId);
      if (numId !== null) {
        dbPreorders.set(numId, {
          advance: Number(row.advance),
          remaining: Number(row.remaining),
          total: Number(row.total)
        });
      }
    });
    console.log(`✔ Cached ${dbPreorders.size} historical pre-order pricing configurations.`);
  } catch (err) {
    console.log("ℹ No pre-orders found or error querying them (continuing with defaults).", err.message);
  }

  // 4. Create Audit Log Run
  const initRunRes = await pgClient.query(`
    INSERT INTO migration_runs (status, executed_by)
    VALUES ('Started', 'Excel Rebuild Script')
    RETURNING id;
  `);
  const runId = initRunRes.rows[0].id;

  try {
    // 5. Truncate all relational tables
    console.log("Clearing database tables...");
    await pgClient.query('BEGIN');
    await pgClient.query(`
      TRUNCATE TABLE 
        expenses, 
        order_items, 
        orders, 
        inventory_transactions, 
        inventory, 
        product_images, 
        products, 
        customers, 
        profiles, 
        users,
        system_notifications,
        split_settlements,
        receipts,
        receipt_items,
        receipt_generation_jobs
      RESTART IDENTITY CASCADE;
    `);
    console.log("✔ Database tables cleared successfully.");

    // 6. Re-seed Admin Founders
    console.log("Seeding admin founders...");
    const founders = [
      { email: 'harshalgadhe123@gmail.com', name: 'Harshal', cognito: '7113cdfa-d021-7082-178e-ec3f8ff840c4' },
      { email: 'anutosh@garagekings.com', name: 'Anutosh', cognito: 'cognito-sub-anutosh' },
      { email: 'sanchit@garagekings.com', name: 'Sanchit', cognito: 'cognito-sub-sanchit' },
      { email: 'anish@garagekings.com', name: 'Anish', cognito: 'cognito-sub-anish' }
    ];
    const founderIdsMap = {};
    for (const f of founders) {
      const userRes = await pgClient.query(`
        INSERT INTO users (email, role, cognito_sub)
        VALUES ($1, 'Owner', $2)
        RETURNING id;
      `, [f.email, f.cognito]);
      const userId = userRes.rows[0].id;
      founderIdsMap[f.name] = userId;

      await pgClient.query(`
        INSERT INTO profiles (user_id, username, display_name, avatar_url)
        VALUES ($1, $2, $3, $4);
      `, [userId, f.name.toLowerCase(), f.name, `https://ui-avatars.com/api/?name=${f.name}&background=ff5500&color=fff`]);
    }
    console.log("✔ Seeding of admin founders completed.");

    // 7. Insert products from Inventory Sheet (merge duplicate SKUs)
    console.log("Processing and inserting products...");
    const mergedProducts = {};
    for (const row of rawProducts) {
      const sku = row['SKU ID'].toString().trim();
      const brand = row['Brand'] ? row['Brand'].toString().trim() : 'Unknown';
      const name = row['Product Name'] ? row['Product Name'].toString().trim() : 'Unnamed Product';
      const series = row['Series'] ? row['Series'].toString().trim() : 'NA';
      const scale = row['Scale'] ? row['Scale'].toString().trim() : '1:64';
      const color = row['Color Variant'] ? row['Color Variant'].toString().trim() : 'NA';
      const purchaseDate = parseExcelDate(row['Purchase Date']);
      const purchasePrice = Number(row['Purchase Price'] || 0);
      const sellingPrice = Number(row['Selling Price'] || 0);
      const qtyPurchased = Number(row['Quantity Purchased'] || 0);
      const qtySold = Number(row['Quantity Sold'] || 0);

      if (mergedProducts[sku]) {
        mergedProducts[sku].totalStock += qtyPurchased;
        mergedProducts[sku].soldStock += qtySold;
        mergedProducts[sku].purchasePrice = purchasePrice;
        mergedProducts[sku].price = sellingPrice;
      } else {
        mergedProducts[sku] = {
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
          lane: series === 'NA' ? 'Standard Edition' : series,
          category: brand.toLowerCase().includes('hotwheels') ? 'Mainline' : 'JDM',
          tags: series !== 'NA' ? [series] : []
        };
      }
    }

    const productIdsMap = {};
    for (const sku of Object.keys(mergedProducts)) {
      const p = mergedProducts[sku];
      const isPrebook = p.sku.toUpperCase().startsWith('PRE') || p.sku.toUpperCase().includes('PREBOOK') || p.name.toLowerCase().includes('pre-booking');
      
      const prodRes = await pgClient.query(`
        INSERT INTO products (sku, brand, model_name, series, scale, rarity_level, base_price, description, tags, category, purchase_price, selling_price, total_stock, sold_stock, status, is_prebook)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Published', $15)
        RETURNING id;
      `, [
        p.sku,
        p.brand,
        p.name,
        p.series,
        p.scale,
        p.lane,
        p.price,
        `Premium highly-detailed scale model. Color Variant: ${p.color}.`,
        p.tags,
        p.category,
        p.purchasePrice,
        p.price,
        p.totalStock,
        p.soldStock,
        isPrebook
      ]);
      const productId = prodRes.rows[0].id;
      productIdsMap[p.sku] = productId;

      await pgClient.query(`
        INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
        VALUES ($1, '/placeholder-car.png', '/placeholder-car.png', '/placeholder-car.png', true);
      `, [productId]);

      const quantityAvailable = Math.max(0, p.totalStock - p.soldStock);
      await pgClient.query(`
        INSERT INTO inventory (product_id, quantity_available, quantity_reserved)
        VALUES ($1, $2, 0);
      `, [productId, quantityAvailable]);
    }
    console.log(`✔ Seeding of ${Object.keys(mergedProducts).length} products completed.`);

    // 8. Insert customers & orders
    console.log("Processing and inserting customers and orders...");
    for (const row of rawOrders) {
      const excelOrderId = row['Order ID'].toString().trim();
      const customerName = row['Customer Name '] ? row['Customer Name '].toString().trim() : 'Guest Customer';
      const rawPhone = row['Phone Number'] ? row['Phone Number'].toString().trim() : '';
      const phone = rawPhone && rawPhone !== 'NA' ? rawPhone : `unknown_${excelOrderId}`;
      const address = row['Address'] ? row['Address'].toString().trim() : 'No Address';
      const skusColumn = row['SUK IDs'] ? row['SUK IDs'].toString().trim() : '';
      const amountPaid = Number(row['Amount Paid'] || 0);
      const status = row['Status'] ? row['Status'].toString().trim() : 'Pending';
      const receiptDone = row['Receipt'] ? row['Receipt'].toString().trim() === 'Done' : false;
      const orderDate = parseExcelDate(row['Date']);
      const type = row['Type'] ? row['Type'].toString().trim() : 'Order';

      // Clean phone and map email
      const cleanPhone = phone.replace(/[^0-9]/g, '');
      const emailClean = `${cleanPhone || excelOrderId}@guest.garagekings.in`.toLowerCase();

      // Resolve Customer ID
      let customerId;
      const custCheck = await pgClient.query('SELECT id FROM customers WHERE email = $1', [emailClean]);
      if (custCheck.rows.length > 0) {
        customerId = custCheck.rows[0].id;
      } else {
        const custRes = await pgClient.query(`
          INSERT INTO customers (full_name, phone, address, email, city)
          VALUES ($1, $2, $3, $4, 'Unknown')
          RETURNING id;
        `, [customerName, phone, address, emailClean]);
        customerId = custRes.rows[0].id;
      }

      // Resolve User ID
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

      // Resolve Pre-order amounts
      let advancePaid = amountPaid;
      let pendingBalance = 0;
      let totalAmount = amountPaid;
      const bookingType = (type === 'Pre-Booking') ? 'pre_order' : 'standard';

      if (type === 'Pre-Booking') {
        const numId = getNumericId(excelOrderId);
        const dbRecord = numId !== null ? dbPreorders.get(numId) : null;
        if (dbRecord) {
          advancePaid = dbRecord.advance;
          pendingBalance = dbRecord.remaining;
          totalAmount = dbRecord.total;
        } else {
          // Calculate using defaults
          let calculatedRemaining = 0;
          const skuList = skusColumn.split(',').map(s => s.trim().toUpperCase());
          skuList.forEach(s => {
            if (prebookDefaults[s]) {
              calculatedRemaining += prebookDefaults[s];
            } else {
              calculatedRemaining += 1700; // general default pre-order remaining balance
            }
          });
          advancePaid = amountPaid;
          pendingBalance = calculatedRemaining;
          totalAmount = advancePaid + pendingBalance;
        }
      }

      // Map order status
      let dbStatus = 'Pending';
      if (pendingBalance === 0 && status.toLowerCase() === 'done') {
        dbStatus = 'Delivered';
      } else if (status.toLowerCase() === 'in process' || status.toLowerCase() === 'done') {
        dbStatus = 'Confirmed';
      }

      // Insert Order
      const orderInsertRes = await pgClient.query(`
        INSERT INTO orders (user_id, total_price, shipping_address, status, booking_type, advance_amount, remaining_amount, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        RETURNING id;
      `, [
        userId,
        totalAmount,
        `${address} | Phone: ${phone}`,
        dbStatus,
        bookingType,
        advancePaid,
        pendingBalance,
        orderDate
      ]);
      const orderId = orderInsertRes.rows[0].id;

      // Insert Order Items
      const skuList = skusColumn.split(',').map(s => s.trim());
      for (const s of skuList) {
        if (!s) continue;
        const productId = productIdsMap[s];
        if (productId) {
          await pgClient.query(`
            INSERT INTO order_items (order_id, product_id, qty, price_at_purchase)
            VALUES ($1, $2, 1, $3);
          `, [orderId, productId, advancePaid]); // fallback purchase price to amountPaid
        } else {
          console.warn(`⚠️ Warning: SKU ${s} not found in productIdsMap for Order ${excelOrderId}`);
        }
      }

      // Insert Receipt if completed
      if (receiptDone) {
        const formatType = (type === 'Pre-Booking') ? 'prebooking' : 'standard';
        const pdfUrl = `https://gk-public-assets.s3.ap-south-1.amazonaws.com/receipts/${excelOrderId}.pdf`;

        const receiptInsertRes = await pgClient.query(`
          INSERT INTO receipts (
            receipt_number, customer_id, format_type, tax_percent, tax_amount, 
            shipping_charges, total_amount, advance_paid, pending_balance, footer_note, 
            customer_name, customer_phone, customer_address, created_at, order_id, pdf_url
          )
          VALUES ($1, $2, $3, 0.00, 0.00, 0.00, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING id;
        `, [
          excelOrderId,
          customerId,
          formatType,
          totalAmount,
          advancePaid,
          pendingBalance,
          'In the event that the order cannot be fulfilled from our end, a full refund will be issued.',
          customerName,
          phone,
          address,
          orderDate,
          orderId,
          pdfUrl
        ]);
        const receiptId = receiptInsertRes.rows[0].id;

        // Insert Receipt Items
        for (const s of skuList) {
          if (!s) continue;
          const prodId = productIdsMap[s];
          const prodName = rawProducts.find(p => p['SKU ID'] === s)?.['Product Name'] || s;
          await pgClient.query(`
            INSERT INTO receipt_items (receipt_id, description, qty, amount)
            VALUES ($1, $2, 1, $3);
          `, [receiptId, `${prodName} - ${s}`, advancePaid]);
        }

        // Insert Receipt generation job
        await pgClient.query(`
          INSERT INTO receipt_generation_jobs (receipt_id, status, pdf_s3_url)
          VALUES ($1, 'Completed', $2);
        `, [receiptId, pdfUrl]);
      }
    }
    console.log(`✔ Seeding of ${rawOrders.length} orders completed.`);

    // 9. Seed expenses from Expense sheet
    console.log("Processing and inserting expenses...");
    for (const row of rawExpenses) {
      const description = row['Description'].toString().trim();
      const doneBy = row['Done By'] ? row['Done By'].toString().trim() : 'Unknown';
      const amount = Number(row['Amount'] || 0);
      const settled = row['Settled '] ? row['Settled '].toString().trim().toLowerCase() === 'yes' : false;

      let category = 'Other';
      const descLower = description.toLowerCase();
      if (descLower.includes('shipping') || descLower.includes('delivery') || descLower.includes('shiprocket')) {
        category = 'Shipping';
      } else if (descLower.includes('wrap') || descLower.includes('packaging') || descLower.includes('box') || descLower.includes('case')) {
        category = 'Packaging';
      } else if (descLower.includes('marketing')) {
        category = 'Marketing';
      } else if (descLower.includes('website') || descLower.includes('stand')) {
        category = 'Operations';
      }

      await pgClient.query(`
        INSERT INTO expenses (title, amount, category, paid_by, date, notes)
        VALUES ($1, $2, $3, $4, NOW(), $5);
      `, [
        description,
        amount,
        category,
        doneBy,
        `Imported from Excel sheet. Settled: ${settled}`
      ]);
    }
    console.log(`✔ Seeding of ${rawExpenses.length} expenses completed.`);

    await pgClient.query('COMMIT');

    // 10. Update migration run status
    await pgClient.query(`
      UPDATE migration_runs 
      SET status = 'Completed', records_processed = $1, completed_at = NOW() 
      WHERE id = $2;
    `, [rawOrders.length, runId]);

    console.log("==================================================");
    console.log("✔ DATABASE REBUILD COMPLETED SUCCESSFULLY!");
    console.log("==================================================");

  } catch (error) {
    await pgClient.query('ROLLBACK');
    console.error("❌ Database import failed! SQL Transaction rolled back successfully.", error);
    await pgClient.query(`
      UPDATE migration_runs 
      SET status = 'Failed', error_summary = $1, completed_at = NOW() 
      WHERE id = $2;
    `, [error.message, runId]);
  } finally {
    pgClient.release();
    await pgPool.end();
  }
}

runImport().catch(console.error);
