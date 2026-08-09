import fs from 'fs';
import path from 'path';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const catalogPath = path.join(process.cwd(), '..', 'data', 'garagekings_marketplace_catalog_v2.json');
const manifestPath = path.join(process.cwd(), '..', 'data', 'catalog-images', 'image-manifest.json');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const imageManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];

const dbUrl = process.env.DATABASE_URL;
const sslOption = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: sslOption,
});

const bucketName = process.env.S3_ASSETS_BUCKET || 'gk-production-public-assets-2026';
const awsRegion = process.env.AWS_REGION || 'ap-south-1';

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
  try {
    const boundary = `----GarageKingsUpload${Math.random().toString(36).substring(2)}`;
    const buffer = fs.readFileSync(localFilePath);
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${path.basename(s3Key)}"\r\n` +
      `Content-Type: image/webp\r\n\r\n`
    );
    const folderPart = Buffer.from(
      `\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="folder"\r\n\r\n' +
      `products/${path.dirname(s3Key).replace(/^products\/?/, '')}\r\n--${boundary}--\r\n`
    );
    const multipartBody = Buffer.concat([prefix, buffer, folderPart]);

    const res = await fetch('http://localhost:5001/api/v1/images/upload', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: multipartBody
    });

    if (res.ok) {
      const data = await res.json();
      return data.url || data.path || data.fileUrl || data.location || data.key || `https://${bucketName}.s3.amazonaws.com/${s3Key}`;
    }
  } catch (e) {
    console.warn(`Local upload endpoint warning for ${s3Key}: ${e.message}`);
  }

  // S3 Fallback
  const fileBuffer = fs.readFileSync(localFilePath);
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: 'image/webp'
  });
  await s3Client.send(command);
  return `https://${bucketName}.s3.amazonaws.com/${s3Key}`;
}

async function main() {
  const client = await pool.connect();

  try {
    console.log(`====================================================================`);
    console.log(`GARAGEKINGS BACKFILL: PRE-BOOK CATALOG PRODUCTS ONLY (12 ITEMS)`);
    console.log(`====================================================================\n`);

    const existingSkusRes = await client.query('SELECT sku FROM products;');
    const existingSkus = new Set(existingSkusRes.rows.map(r => r.sku));

    const casingRes = await client.query('SELECT id, name FROM casing_types;');
    const casingMap = {};
    for (const c of casingRes.rows) {
      casingMap[c.name.toUpperCase()] = c.id;
    }

    const imagesBySku = new Map();
    for (const imgRec of imageManifest) {
      if (!imagesBySku.has(imgRec.sku)) {
        imagesBySku.set(imgRec.sku, []);
      }
      imagesBySku.get(imgRec.sku).push(imgRec);
    }

    // Filter ONLY prebook products (isPrebook === true)
    const prebookProducts = catalog.products.filter(p => p.isPrebook);
    console.log(`Found ${prebookProducts.length} pre-book catalog products to backfill.\n`);

    let insertedCount = 0;
    let skippedCount = 0;
    let uploadedCount = 0;

    for (let i = 0; i < prebookProducts.length; i++) {
      const p = prebookProducts[i];
      const sku = p.sku;

      if (existingSkus.has(sku)) {
        console.log(`[${i + 1}/${prebookProducts.length}] ⏭️ Skipping SKU "${sku}" (Already exists).`);
        skippedCount++;
        continue;
      }

      console.log(`[${i + 1}/${prebookProducts.length}] Backfilling pre-book SKU "${sku}" (${p.brand} - ${p.name})...`);

      const skuImages = imagesBySku.get(sku) || [];
      const uploadedS3Urls = [];

      for (const imgRec of skuImages) {
        const fullLocalPath = path.join(process.cwd(), '..', imgRec.localPath);
        if (fs.existsSync(fullLocalPath)) {
          try {
            const s3Url = await uploadFileToS3(fullLocalPath, imgRec.s3Key);
            uploadedS3Urls.push(s3Url);
            uploadedCount++;
            console.log(`  ☁️ Uploaded S3 asset: ${imgRec.s3Key}`);
          } catch (uploadErr) {
            console.warn(`  ⚠️ S3 Upload failed for ${imgRec.s3Key}: ${uploadErr.message}`);
            uploadedS3Urls.push(`https://${bucketName}.s3.amazonaws.com/${imgRec.s3Key}`);
          }
        }
      }

      const primaryImg = uploadedS3Urls[0] || "";
      const priceVal = Number(p.price || p.sellingPrice || 0);
      const stockVal = Number(p.stock !== undefined ? p.stock : (p.availableStock || 0));
      const poDeposit = Number(p.poAmount !== undefined ? p.poAmount : (p.prebookDepositAmount || 0));
      const reqCasing = p.casing || 'Blister';
      const rawCasingUpper = reqCasing.toUpperCase();

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
        stockVal,
        stockVal,
        stockVal,
        true,
        Boolean(p.isFeatured),
        p.status || 'Pre-Order',
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

      for (let idx = 0; idx < uploadedS3Urls.length; idx++) {
        const imgUrl = uploadedS3Urls[idx];
        const isPrimary = idx === 0;
        await client.query(`
          INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
          VALUES ($1, $2, $3, $4, $5);
        `, [productId, imgUrl, imgUrl, imgUrl, isPrimary]);
      }

      const casingTypeId = casingMap[rawCasingUpper] || casingRes.rows[0]?.id;
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
        variantObj.salesStatus || 'Preorder',
        variantObj.dimensions || null,
        variantObj.weight ? Number(variantObj.weight) : null,
        variantObj.variantAttributes ? JSON.stringify(variantObj.variantAttributes) : '{}',
        stockVal,
        'System Backfill'
      ]);

      insertedCount++;
      existingSkus.add(sku);
      console.log(`  ✅ Successfully backfilled pre-book product SKU "${sku}".`);
    }

    console.log(`\n🎉 PRE-BOOK PRODUCTS BACKFILL COMPLETE!`);
    console.log(`- Inserted Pre-Book Products: ${insertedCount}`);
    console.log(`- Skipped Duplicates: ${skippedCount}`);
    console.log(`- S3 WebP Assets Uploaded: ${uploadedCount}`);

  } catch (err) {
    console.error('❌ Error during pre-book backfill:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
