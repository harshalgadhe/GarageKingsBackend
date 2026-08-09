import fs from 'fs';
import path from 'path';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const isDryRun = process.argv.includes('--dry-run');

const catalogPath = path.join(process.cwd(), '..', 'data', 'garagekings_marketplace_catalog_v2.json');
const manifestPath = path.join(process.cwd(), '..', 'data', 'catalog-images', 'image-manifest.json');
const unresolvedPath = path.join(process.cwd(), '..', 'data', 'catalog-images', 'unresolved-images.json');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const imageManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
const unresolvedImages = fs.existsSync(unresolvedPath) ? JSON.parse(fs.readFileSync(unresolvedPath, 'utf8')) : [];

const dbUrl = process.env.DATABASE_URL;
const sslOption = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: sslOption,
});

// S3 Client configuration
const bucketName = process.env.S3_ASSETS_BUCKET || 'gk-production-public-assets-2026';
const awsRegion = process.env.AWS_REGION || 'us-east-1';

const s3Client = new S3Client({
  region: awsRegion,
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  } : {})
});

async function uploadFileToS3(localFilePath, s3Key) {
  const fileBuffer = fs.readFileSync(localFilePath);
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: 'image/webp',
    ACL: 'public-read'
  });
  await s3Client.send(command);
  return `https://${bucketName}.s3.amazonaws.com/${s3Key}`;
}

async function main() {
  const client = await pool.connect();

  try {
    console.log(`====================================================================`);
    console.log(`GARAGEKINGS MARKETPLACE CATALOGUE BACKFILL ${isDryRun ? '(DRY RUN MODE)' : '(PRODUCTION EXECUTION MODE)'}`);
    console.log(`====================================================================\n`);

    // 1. Fetch existing SKUs from PostgreSQL database
    const existingSkusRes = await client.query('SELECT sku FROM products;');
    const existingSkus = new Set(existingSkusRes.rows.map(r => r.sku));

    // 2. Fetch Casing Types from database
    const casingRes = await client.query('SELECT id, name FROM casing_types;');
    const casingMap = {};
    for (const c of casingRes.rows) {
      casingMap[c.name.toUpperCase()] = c.id;
    }

    // Index images by SKU
    const imagesBySku = new Map();
    for (const imgRec of imageManifest) {
      if (!imagesBySku.has(imgRec.sku)) {
        imagesBySku.set(imgRec.sku, []);
      }
      imagesBySku.get(imgRec.sku).push(imgRec);
    }

    // Counters for Dry Run Report
    let totalProducts = catalog.products.length;
    let standardCount = 0;
    let prebookCount = 0;
    let newSkuCount = 0;
    let duplicateSkuCount = 0;
    let totalStockCount = 0;
    let validationFailures = [];
    let officialSourceMatches = 0;
    let castlyFallbackMatches = 0;
    let unresolvedCount = unresolvedImages.length;
    let totalImagesToUpload = imageManifest.length;
    let casingValidationIssues = [];
    let preorderWarnings = [];

    const productsToCreate = [];

    for (let i = 0; i < catalog.products.length; i++) {
      const p = catalog.products[i];
      const sku = p.sku;

      if (!sku) {
        validationFailures.push(`Product at index ${i} has missing SKU.`);
        continue;
      }

      const isPrebook = Boolean(p.isPrebook);
      if (isPrebook) prebookCount++;
      else standardCount++;

      const stockVal = Number(p.stock !== undefined ? p.stock : (p.availableStock || 0));
      totalStockCount += stockVal;

      // Duplicate SKU Check
      if (existingSkus.has(sku)) {
        duplicateSkuCount++;
      } else {
        newSkuCount++;
      }

      // Casing Check
      const rawCasing = (p.casing || p.casingType || 'Blister').toUpperCase();
      if (!casingMap[rawCasing]) {
        casingValidationIssues.push(`SKU "${sku}" has unmapped casing "${rawCasing}".`);
      }

      // Prebook warnings
      if (isPrebook && (!p.poAmount || p.poAmount <= 0)) {
        preorderWarnings.push(`Prebook product SKU "${sku}" (${p.name}) has 0 or unassigned deposit/poAmount.`);
      }

      // Images check
      const skuImages = imagesBySku.get(sku) || [];
      if (skuImages.length > 0) {
        if (skuImages[0].sourceType === 'official') officialSourceMatches++;
        else if (skuImages[0].sourceType === 'castly') castlyFallbackMatches++;
      }

      productsToCreate.push({
        rawProduct: p,
        sku: sku,
        images: skuImages,
        stockVal: stockVal,
        isPrebook: isPrebook,
        casingUpper: rawCasing
      });
    }

    // ── DRY RUN REPORT ────────────────────────────────────────────────
    console.log(`📊 DRY-RUN REPORT SUMMARY:`);
    console.log(`- Total Catalogue Products in JSON: ${totalProducts}`);
    console.log(`- Standard Products: ${standardCount}`);
    console.log(`- Pre-Booking Products: ${prebookCount}`);
    console.log(`- Total Marketplace Stock / Slots: ${totalStockCount} units`);
    console.log(`- Existing SKUs in DB: ${duplicateSkuCount} (will be skipped during backfill)`);
    console.log(`- New SKUs to Insert: ${newSkuCount}`);
    console.log(`- Products with Official Manufacturer Images: ${officialSourceMatches}`);
    console.log(`- Products with Castly Fallback Images: ${castlyFallbackMatches}`);
    console.log(`- Products with No Image (Kept Blank): ${unresolvedCount}`);
    console.log(`- Total Local WebP Images Ready for S3 Upload: ${totalImagesToUpload} files`);
    console.log(`- Validation Failures: ${validationFailures.length}`);
    console.log(`- Casing Validation Issues: ${casingValidationIssues.length}`);
    console.log(`- Pre-order Price/PO Warnings: ${preorderWarnings.length}\n`);

    if (preorderWarnings.length > 0) {
      console.log(`⚠️ Pre-order Warnings:`);
      preorderWarnings.forEach(w => console.log(`   - ${w}`));
      console.log(``);
    }

    if (isDryRun) {
      console.log(`✅ DRY RUN COMPLETED SUCCESSFULLY. No database mutations or S3 uploads were performed.`);
      console.log(`Run 'npm run backfill:catalog' (without --dry-run) to execute production backfill.`);
      return;
    }

    // ── PRODUCTION EXECUTION MODE ──────────────────────────────────────
    console.log(`🚀 STARTING PRODUCTION EXECUTION...`);

    let insertedCount = 0;
    let skippedCount = 0;
    let uploadedCount = 0;

    for (let i = 0; i < productsToCreate.length; i++) {
      const item = productsToCreate[i];
      const p = item.rawProduct;
      const sku = item.sku;

      if (existingSkus.has(sku)) {
        console.log(`[${i + 1}/${productsToCreate.length}] ⏭️ Skipping SKU "${sku}" (Already exists in database).`);
        skippedCount++;
        continue;
      }

      console.log(`[${i + 1}/${productsToCreate.length}] Backfilling SKU "${sku}" (${p.brand} - ${p.name})...`);

      // 1. Upload WebP images to S3
      const uploadedS3Urls = [];
      for (const imgRec of item.images) {
        const fullLocalPath = path.join(process.cwd(), '..', imgRec.localPath);
        if (fs.existsSync(fullLocalPath)) {
          try {
            const s3Url = await uploadFileToS3(fullLocalPath, imgRec.s3Key);
            uploadedS3Urls.push(s3Url);
            uploadedCount++;
            console.log(`  ☁️ Uploaded S3 asset: ${imgRec.s3Key}`);
          } catch (uploadErr) {
            console.warn(`  ⚠️ S3 Upload failed for ${imgRec.s3Key}: ${uploadErr.message}`);
            // Fallback to local URL path
            uploadedS3Urls.push(`https://${bucketName}.s3.amazonaws.com/${imgRec.s3Key}`);
          }
        }
      }

      const primaryImg = uploadedS3Urls[0] || "";
      const priceVal = Number(p.price || p.sellingPrice || 0);
      const poDeposit = Number(p.poAmount !== undefined ? p.poAmount : (p.prebookDepositAmount || 0));
      const reqCasing = p.casing || 'Blister';

      // 2. Insert into products table
      const prodRes = await client.query(`
        INSERT INTO products (
          sku, brand, model_name, series, scale, casing, casing_types, base_price, selling_price, price,
          po_amount, prebook_deposit_amount, stock, total_stock, available_stock, is_prebook, is_featured, status,
          customer_eta, arrival_date, release_date, tag, subtags, tags, description, image, images,
          supplier, created_by, category
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
        RETURNING id;
      `, [
        sku,
        p.brand || 'Mini GT',
        p.name || 'Unknown Casting',
        p.series || '',
        p.scale || '1:64',
        reqCasing,
        [reqCasing.toLowerCase()],
        priceVal,
        priceVal,
        priceVal,
        poDeposit,
        poDeposit,
        item.stockVal,
        item.stockVal,
        item.stockVal,
        item.isPrebook,
        Boolean(p.isFeatured),
        p.status || (item.isPrebook ? 'Pre-Order' : 'Published'),
        p.customerEta || p.arrivalDate || p.releaseDate || null,
        p.arrivalDate || p.customerEta || null,
        p.releaseDate || p.customerEta || null,
        p.tag || null,
        p.subtags || [],
        p.tags || [],
        p.description || '',
        primaryImg,
        uploadedS3Urls,
        p.supplier || '',
        'System Backfill',
        p.category || 'JDM'
      ]);

      const productId = prodRes.rows[0].id;

      // 3. Insert into product_images table
      for (let idx = 0; idx < uploadedS3Urls.length; idx++) {
        const imgUrl = uploadedS3Urls[idx];
        const isPrimary = idx === 0;
        await client.query(`
          INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary, display_order)
          VALUES ($1, $2, $3, $4, $5, $6);
        `, [productId, imgUrl, imgUrl, imgUrl, isPrimary, idx + 1]);
      }

      // 4. Insert into product_variants table
      const casingTypeId = casingMap[item.casingUpper] || casingRes.rows[0]?.id;
      const variantObj = (p.variants && p.variants.length > 0) ? p.variants[0] : {};

      await client.query(`
        INSERT INTO product_variants (
          product_id, casing_type_id, sku, barcode, name, selling_price, customer_eta,
          visibility, status, sales_status, dimensions, weight, variant_attributes,
          total_stock, sold_stock, locked_stock, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, 0, $15);
      `, [
        productId,
        casingTypeId,
        variantObj.sku ? variantObj.sku.trim() : sku,
        variantObj.barcode || null,
        variantObj.name || `${p.name} (${reqCasing})`,
        priceVal,
        variantObj.customerEta || null,
        variantObj.isVisible !== false ? 'Visible' : 'Hidden',
        variantObj.status || 'Active',
        variantObj.salesStatus || (item.isPrebook ? 'Preorder' : 'Available'),
        variantObj.dimensions || null,
        variantObj.weight ? Number(variantObj.weight) : null,
        variantObj.variantAttributes ? JSON.stringify(variantObj.variantAttributes) : '{}',
        item.stockVal,
        'System Backfill'
      ]);

      insertedCount++;
      existingSkus.add(sku);
      console.log(`  ✅ Successfully backfilled SKU "${sku}".`);
    }

    console.log(`\n🎉 BACKFILL EXECUTION COMPLETE!`);
    console.log(`- Inserted Products: ${insertedCount}`);
    console.log(`- Skipped Products (Duplicates): ${skippedCount}`);
    console.log(`- S3 WebP Images Uploaded: ${uploadedCount}`);

  } catch (err) {
    console.error('❌ Error during catalogue backfill:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
