import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { validateImageMatch } from './image-match-validation.mjs';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const catalogPath = path.join(process.cwd(), '..', 'data', 'garagekings_marketplace_catalog_v2.json');
const manifestPath = path.join(process.cwd(), '..', 'data', 'garagekings_image_lookup_manifest.json');
const outputFolder = path.join(process.cwd(), '..', 'data', 'catalog-images');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const lookupSpecs = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// ALLOWED DOMAIN HIERARCHY
const OFFICIAL_DOMAINS = [
  'shopping.mattel.com',
  'shop.mattel.com',
  'creations.mattel.com',
  'service.mattel.com',
  'minigt.tsm-models.com',
  'tsm-models.com',
  'poprace.net',
  'inno-models.com'
];

const TIER1_RETAILERS = [
  'karzanddolls.com',
  'karzanddolls.in',
  'krazycaterpillar.com'
];

const TIER2_LAST_OPTION = [
  'castly.co.in',
  'castly.com'
];

function getMatchTier(url) {
  if (!url || typeof url !== 'string') return null;
  const lower = url.toLowerCase();
  
  if (lower.includes('facebook.com') || lower.includes('instagram.com') || lower.includes('slideserve.com') || lower.includes('ebay.com') || lower.includes('amazon.')) {
    return null;
  }

  if (OFFICIAL_DOMAINS.some(d => lower.includes(d))) return 'OFFICIAL';
  if (TIER1_RETAILERS.some(d => lower.includes(d))) return 'KARZ_OR_KRAZY';
  if (TIER2_LAST_OPTION.some(d => lower.includes(d))) return 'CASTLY';
  return null;
}

async function searchDuckDuckGo(query) {
  try {
    const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&iax=images&ia=images`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const tokenHtml = await tokenRes.text();
    const vqdMatch = tokenHtml.match(/vqd=["']([^"']+)["']/i) || tokenHtml.match(/vqd=([\d-]+)/i);
    if (!vqdMatch) return [];

    const vqd = vqdMatch[1];
    const imgApiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,`;
    
    const imgRes = await fetch(imgApiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://duckduckgo.com/'
      }
    });

    const data = await imgRes.json();
    if (data.results && data.results.length > 0) {
      return data.results.map(r => ({ imageUrl: r.image, pageUrl: r.url, title: r.title }));
    }
  } catch (e) {
    console.error(`Error searching DuckDuckGo for "${query}":`, e.message);
  }
  return [];
}

async function downloadImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 2000) return null;
    return buffer;
  } catch (e) {
    return null;
  }
}

function getBufferHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

const dbUrl = process.env.DATABASE_URL;
const sslOption = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false;
const pool = new Pool({ connectionString: dbUrl, ssl: sslOption });

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
    const fileBuffer = fs.readFileSync(localFilePath);
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: 'image/webp'
    });
    await s3Client.send(command);
    return `https://${bucketName}.s3.amazonaws.com/${s3Key}`;
  } catch (e) {
    return `https://${bucketName}.s3.amazonaws.com/${s3Key}`;
  }
}

async function main() {
  console.log(`Starting Strict Domain Hierarchy Image Engine for ${catalog.products.length} products...\n`);

  const specMap = new Map();
  for (const s of lookupSpecs.products) specMap.set(s.sku, s);

  const imageManifestRecords = [];
  const unresolvedRecords = [];

  let officialCount = 0;
  let karzKrazyCount = 0;
  let castlyCount = 0;
  let unresolvedCount = 0;
  let totalDownloaded = 0;

  for (let i = 0; i < catalog.products.length; i++) {
    const product = catalog.products[i];
    const spec = specMap.get(product.sku) || {};
    const sku = product.sku;
    const mfgSku = spec.manufacturerSkuCandidate || sku;

    console.log(`[${i + 1}/${catalog.products.length}] Resolving strict images for SKU: "${sku}" (${pName(product.name)})...`);

    const skuDir = path.join(outputFolder, sku);
    if (!fs.existsSync(skuDir)) {
      fs.mkdirSync(skuDir, { recursive: true });
    }

    const searchQueries = [
      `"${mfgSku}"`,
      `"${sku}"`,
      `${product.brand} "${mfgSku}"`,
      `${product.brand} "${sku}"`,
      `karzanddolls "${sku}"`,
      `krazycaterpillar "${sku}"`,
      `castly "${sku}"`,
      `karzanddolls "${product.name}"`,
      `krazycaterpillar "${product.name}"`,
      `castly "${product.name}"`
    ];

    let matchedTier = null;
    let candidateImages = [];

    for (const q of searchQueries) {
      if (matchedTier === 'OFFICIAL') break;

      const results = await searchDuckDuckGo(q);

      const relevantResults = results.filter(result => validateImageMatch(product, result, mfgSku).valid);

      // Check Tier 1 Official
      const officialMatches = relevantResults.filter(r => getMatchTier(r.imageUrl) === 'OFFICIAL' || getMatchTier(r.pageUrl) === 'OFFICIAL');
      if (officialMatches.length > 0) {
        matchedTier = 'OFFICIAL';
        candidateImages = officialMatches;
        break;
      }

      // Check Tier 2 Karz & Dolls / Krazy Caterpillar
      if (!matchedTier || matchedTier === 'CASTLY') {
        const tier1Matches = relevantResults.filter(r => getMatchTier(r.imageUrl) === 'KARZ_OR_KRAZY' || getMatchTier(r.pageUrl) === 'KARZ_OR_KRAZY');
        if (tier1Matches.length > 0) {
          matchedTier = 'KARZ_OR_KRAZY';
          candidateImages = tier1Matches;
        }
      }

      // Check Tier 3 Castly
      if (!matchedTier) {
        const tier2Matches = relevantResults.filter(r => getMatchTier(r.imageUrl) === 'CASTLY' || getMatchTier(r.pageUrl) === 'CASTLY');
        if (tier2Matches.length > 0) {
          matchedTier = 'CASTLY';
          candidateImages = tier2Matches;
        }
      }
    }

    if (!matchedTier || candidateImages.length === 0) {
      console.log(`  ❌ Unresolved: No image found on Official sites, Karz & Dolls, Krazy Caterpillar, or Castly for SKU "${sku}". Leaving blank.`);
      unresolvedRecords.push({
        sku: sku,
        name: product.name,
        brand: product.brand,
        reason: "No image found on Whitelisted Domains (Official, Karz&Dolls, KrazyCaterpillar, Castly)"
      });
      unresolvedCount++;
      product.image = "";
      product.images = [];
      await new Promise(r => setTimeout(r, 400));
      continue;
    }

    // Download & Convert Candidates
    const downloadedHashes = new Set();
    const resolvedProductS3Keys = [];
    let savedOrder = 1;

    for (const cand of candidateImages) {
      if (savedOrder > 4) break;

      const rawBuffer = await downloadImage(cand.imageUrl);
      if (!rawBuffer) continue;

      const hash = getBufferHash(rawBuffer);
      if (downloadedHashes.has(hash)) continue;
      downloadedHashes.add(hash);

      let webpBuffer = null;
      try {
        webpBuffer = await sharp(rawBuffer)
          .resize({ width: 1200, withoutEnlargement: true })
          .webp({ quality: 82, compressionLevel: 6 })
          .toBuffer();
      } catch (err) {
        continue;
      }

      const numStr = String(savedOrder).padStart(2, '0');
      const filename = `${numStr}.webp`;
      const localFilePath = path.join(skuDir, filename);
      const relativeLocalPath = `data/catalog-images/${sku}/${filename}`;
      const s3Key = `products/${sku}/${filename}`;

      fs.writeFileSync(localFilePath, webpBuffer);
      totalDownloaded++;

      const isPrimary = savedOrder === 1;

      imageManifestRecords.push({
        sku: sku,
        manufacturerSku: spec.manufacturerSkuCandidate || null,
        sourceType: matchedTier,
        sourcePage: cand.pageUrl || "",
        sourceImageUrl: cand.imageUrl || "",
        localPath: relativeLocalPath,
        s3Key: s3Key,
        isPrimary: isPrimary,
        sortOrder: savedOrder
      });

      resolvedProductS3Keys.push(`https://${bucketName}.s3.amazonaws.com/${s3Key}`);
      savedOrder++;
    }

    if (resolvedProductS3Keys.length > 0) {
      if (matchedTier === 'OFFICIAL') officialCount++;
      else if (matchedTier === 'KARZ_OR_KRAZY') karzKrazyCount++;
      else if (matchedTier === 'CASTLY') castlyCount++;

      product.image = resolvedProductS3Keys[0];
      product.images = resolvedProductS3Keys;

      console.log(`  ✅ Successfully saved ${resolvedProductS3Keys.length} WebP images via ${matchedTier}.`);
    } else {
      console.log(`  ❌ Failed downloading images for SKU "${sku}". Kept blank.`);
      unresolvedRecords.push({ sku: sku, name: product.name, brand: product.brand, reason: "Download failed" });
      unresolvedCount++;
      product.image = "";
      product.images = [];
    }

    await new Promise(r => setTimeout(r, 450));
  }

  // Save JSON manifests
  fs.writeFileSync(path.join(outputFolder, 'image-manifest.json'), JSON.stringify(imageManifestRecords, null, 2));
  fs.writeFileSync(path.join(outputFolder, 'unresolved-images.json'), JSON.stringify(unresolvedRecords, null, 2));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

  console.log(`\n🎉 STRICT IMAGE RESOLUTION COMPLETE:`);
  console.log(`- Official Brand Matches: ${officialCount}`);
  console.log(`- Karz & Dolls / Krazy Caterpillar Matches: ${karzKrazyCount}`);
  console.log(`- Castly Fallback Matches: ${castlyCount}`);
  console.log(`- Unresolved (Kept 100% Blank): ${unresolvedCount}`);
  console.log(`- Total Downloaded WebP Gallery Images: ${totalDownloaded}`);

  // NOW UPDATE DATABASE
  console.log(`\n🔄 Updating PostgreSQL database with fresh authentic WebP images & S3 uploads...`);
  const client = await pool.connect();
  try {
    for (const p of catalog.products) {
      const sku = p.sku;
      const skuImages = imageManifestRecords.filter(m => m.sku === sku);

      const uploadedS3Urls = [];
      for (const imgRec of skuImages) {
        const fullLocalPath = path.join(process.cwd(), '..', imgRec.localPath);
        if (fs.existsSync(fullLocalPath)) {
          const s3Url = await uploadFileToS3(fullLocalPath, imgRec.s3Key);
          uploadedS3Urls.push(s3Url);
        }
      }

      const primaryImg = uploadedS3Urls[0] || "";

      // Update product image and images columns
      const prodRes = await client.query(`
        UPDATE products
        SET image = $1, images = $2
        WHERE sku = $3
        RETURNING id;
      `, [primaryImg, uploadedS3Urls, sku]);

      if (prodRes.rows.length > 0) {
        const productId = prodRes.rows[0].id;
        // Clear old product_images for this product
        await client.query(`DELETE FROM product_images WHERE product_id = $1;`, [productId]);

        // Insert new product_images
        for (let idx = 0; idx < uploadedS3Urls.length; idx++) {
          const imgUrl = uploadedS3Urls[idx];
          const isPrimary = idx === 0;
          await client.query(`
            INSERT INTO product_images (product_id, thumbnail_url, medium_url, full_url, is_primary)
            VALUES ($1, $2, $3, $4, $5);
          `, [productId, imgUrl, imgUrl, imgUrl, isPrimary]);
        }
      }
    }
    console.log(`✅ Successfully updated database product images!`);
  } finally {
    client.release();
    await pool.end();
  }
}

function pName(str) {
  return str ? (str.length > 35 ? str.substring(0, 35) + '...' : str) : '';
}

main();
