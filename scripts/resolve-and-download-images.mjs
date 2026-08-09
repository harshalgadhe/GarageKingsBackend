import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';

const catalogPath = path.join(process.cwd(), '..', 'data', 'garagekings_marketplace_catalog_v2.json');
const manifestPath = path.join(process.cwd(), '..', 'data', 'garagekings_image_lookup_manifest.json');
const outputFolder = path.join(process.cwd(), '..', 'data', 'catalog-images');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const lookupSpecs = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Domain definitions
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

const CASTLY_DOMAIN = 'castly.co.in';

const BANNED_DOMAINS = [
  'reddit.com',
  'redd.it',
  'ebay.com',
  'facebook.com',
  'instagram.com',
  'pinterest.com',
  'aliexpress.com',
  'amazon.com',
  'blogspot.com',
  'youtube.com',
  'twitter.com',
  'x.com',
  'mercaris.com'
];

function isOfficialSource(url, allowedOfficialDomains) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  if (BANNED_DOMAINS.some(b => lower.includes(b))) return false;
  const combinedOfficial = [...OFFICIAL_DOMAINS, ...(allowedOfficialDomains || [])];
  return combinedOfficial.some(d => lower.includes(d.toLowerCase()));
}

function isCastlySource(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  if (BANNED_DOMAINS.some(b => lower.includes(b))) return false;
  return lower.includes(CASTLY_DOMAIN);
}

// Search DuckDuckGo Images
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
      return data.results.map(r => ({
        imageUrl: r.image,
        pageUrl: r.url,
        title: r.title
      }));
    }
  } catch (e) {
    console.error(`Error searching DuckDuckGo for "${query}":`, e.message);
  }
  return [];
}

// Download image buffer
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

// MD5 Hash for deduplication
function getBufferHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function main() {
  console.log(`Starting Image Resolution Engine for ${catalog.products.length} products...\n`);

  const specMap = new Map();
  for (const s of lookupSpecs.products) {
    specMap.set(s.sku, s);
  }

  const imageManifestRecords = [];
  const unresolvedRecords = [];

  let totalDownloaded = 0;
  let officialCount = 0;
  let castlyCount = 0;
  let unresolvedCount = 0;

  for (let i = 0; i < catalog.products.length; i++) {
    const product = catalog.products[i];
    const spec = specMap.get(product.sku) || {};
    const sku = product.sku;

    console.log(`[${i + 1}/${catalog.products.length}] Resolving images for SKU: "${sku}" (${product.brand} - ${product.name})...`);

    const skuDir = path.join(outputFolder, sku);
    if (!fs.existsSync(skuDir)) {
      fs.mkdirSync(skuDir, { recursive: true });
    }

    const officialQuery = spec.officialSearchQuery || `${product.brand} "${product.name}" "${sku}"`;
    const castlyQuery = spec.castlyFallbackSearchQuery || `site:castly.co.in ${product.brand} "${product.name}"`;

    let searchResults = await searchDuckDuckGo(officialQuery);
    let matchedSourceType = null;

    let candidateImages = searchResults.filter(r => isOfficialSource(r.imageUrl, spec.officialDomains) || isOfficialSource(r.pageUrl, spec.officialDomains));

    if (candidateImages.length > 0) {
      matchedSourceType = 'official';
    } else {
      // Try Castly fallback
      const castlyResults = await searchDuckDuckGo(castlyQuery);
      candidateImages = castlyResults.filter(r => isCastlySource(r.imageUrl) || isCastlySource(r.pageUrl));
      if (candidateImages.length > 0) {
        matchedSourceType = 'castly';
      }
    }

    if (candidateImages.length === 0 || !matchedSourceType) {
      console.log(`  ❌ Unresolved: No exact official or Castly image found for SKU "${sku}". Leaving empty.`);
      unresolvedRecords.push({
        sku: sku,
        name: product.name,
        brand: product.brand,
        reason: "Exact livery/casting could not be confidently identified on official domains or Castly fallback",
        searchedSources: [
          spec.officialSearchQuery || officialQuery,
          spec.castlyFallbackSearchQuery || castlyQuery
        ]
      });
      unresolvedCount++;
      product.image = "";
      product.images = [];
      await new Promise(r => setTimeout(r, 400));
      continue;
    }

    // Process & Download Candidates
    const downloadedHashes = new Set();
    const resolvedProductS3Keys = [];
    let savedOrder = 1;

    for (const cand of candidateImages) {
      if (savedOrder > 4) break; // Limit up to 4 distinct gallery images per product

      const rawBuffer = await downloadImage(cand.imageUrl);
      if (!rawBuffer) continue;

      const hash = getBufferHash(rawBuffer);
      if (downloadedHashes.has(hash)) {
        // Skip duplicate image
        continue;
      }
      downloadedHashes.add(hash);

      // Convert to WebP via sharp
      let webpBuffer = null;
      try {
        webpBuffer = await sharp(rawBuffer)
          .resize({ width: 1200, withoutEnlargement: true })
          .webp({ quality: 82, compressionLevel: 6 })
          .toBuffer();
      } catch (err) {
        console.warn(`    Sharp WebP conversion error: ${err.message}`);
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
        sourceType: matchedSourceType,
        sourcePage: cand.pageUrl || "",
        sourceImageUrl: cand.imageUrl || "",
        localPath: relativeLocalPath,
        s3Key: s3Key,
        isPrimary: isPrimary,
        sortOrder: savedOrder
      });

      resolvedProductS3Keys.push(`https://${process.env.S3_ASSETS_BUCKET || 'gk-production-public-assets-2026'}.s3.amazonaws.com/${s3Key}`);
      savedOrder++;
    }

    if (resolvedProductS3Keys.length > 0) {
      if (matchedSourceType === 'official') officialCount++;
      else if (matchedSourceType === 'castly') castlyCount++;

      product.image = resolvedProductS3Keys[0];
      product.images = resolvedProductS3Keys;

      console.log(`  ✅ Successfully saved ${resolvedProductS3Keys.length} official WebP gallery images from ${matchedSourceType} source.`);
    } else {
      console.log(`  ❌ Unresolved after download attempt for SKU "${sku}". Leaving empty.`);
      unresolvedRecords.push({
        sku: sku,
        name: product.name,
        brand: product.brand,
        reason: "Failed downloading/processing image buffer",
        searchedSources: [cand.imageUrl]
      });
      unresolvedCount++;
      product.image = "";
      product.images = [];
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Write manifests
  fs.writeFileSync(path.join(outputFolder, 'image-manifest.json'), JSON.stringify(imageManifestRecords, null, 2));
  fs.writeFileSync(path.join(outputFolder, 'unresolved-images.json'), JSON.stringify(unresolvedRecords, null, 2));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

  console.log(`\n🎉 IMAGE RESOLUTION SUMMARY:`);
  console.log(`- Total Catalog Products: ${catalog.products.length}`);
  console.log(`- Official Source Matches: ${officialCount}`);
  console.log(`- Castly Fallback Matches: ${castlyCount}`);
  console.log(`- Unresolved (Kept Blank): ${unresolvedCount}`);
  console.log(`- Total WebP Gallery Files Downloaded: ${totalDownloaded}`);
  console.log(`- Manifests Saved:`);
  console.log(`  - ${path.join(outputFolder, 'image-manifest.json')}`);
  console.log(`  - ${path.join(outputFolder, 'unresolved-images.json')}`);
}

main();
