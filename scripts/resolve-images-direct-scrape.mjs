import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const catalogPath = path.join(process.cwd(), '..', 'data', 'garagekings_marketplace_catalog_v2.json');
const manifestPath = path.join(process.cwd(), '..', 'data', 'garagekings_image_lookup_manifest.json');
const outputFolder = path.join(process.cwd(), '..', 'data', 'catalog-images');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const lookupSpecs = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return '';
    return await res.text();
  } catch { return ''; }
}

async function scrapeKrazyCaterpillar(numericId, brandSlug, productName) {
  const queries = [];
  if (numericId) queries.push(numericId);
  if (productName) queries.push(productName.split(/\s+/).slice(0, 4).join(' '));
  for (const q of queries) {
    const html = await fetchHtml('https://krazycaterpillar.com/search?q=' + encodeURIComponent(q) + '&type=product');
    if (!html) continue;
    const links = [...new Set([...html.matchAll(/href="(\/products\/[^"?]+)/g)].map(m => m[1]))];
    const matched = links.filter(l => !l.includes('gift-card') && !l.includes('lego') && (!brandSlug || l.includes(brandSlug)));
    if (!matched.length) continue;
    const ph = await fetchHtml('https://krazycaterpillar.com' + matched[0]);
    if (!ph) continue;
    const imgs = [...new Set([...ph.matchAll(/https:\/\/krazycaterpillar\.com\/cdn\/shop\/(?:files|products)\/[^"'\s<>?]+\.(?:jpg|jpeg|png|webp|JPG|JPEG)/gi)].map(m => m[0]))].filter(u => !u.includes('logo'));
    if (imgs.length) return { imgs: imgs.slice(0, 4), sourcePage: 'https://krazycaterpillar.com' + matched[0], tier: 'KARZ_OR_KRAZY' };
  }
  return null;
}

async function scrapeMiniGT(mfgSku) {
  const sh = await fetchHtml('https://minigt.tsm-models.com/index.php?action=product-search&keywords=' + mfgSku);
  if (!sh) return null;
  const lm = sh.match(/href=["']([^"']*product-detail[^"']*)["|']/i);
  if (!lm) return null;
  const du = lm[1].startsWith('http') ? lm[1] : 'https://minigt.tsm-models.com/' + lm[1].replace(/^\//, '');
  const dh = await fetchHtml(du);
  if (!dh) return null;
  const og = dh.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || dh.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og && og[1] && og[1].startsWith('http')) return { imgs: [og[1]], sourcePage: du, tier: 'OFFICIAL' };
  return null;
}

async function scrapeCastly(numericId, productName, brandName) {
  const queries = [];
  if (numericId) queries.push(numericId);
  if (productName) queries.push(productName);
  if (brandName && productName) queries.push(brandName + ' ' + productName);
  for (const q of queries) {
    const html = await fetchHtml('https://www.castly.co.in/search?q=' + encodeURIComponent(q) + '&type=product');
    if (!html) continue;
    const links = [...new Set([...html.matchAll(/href="(\/products\/[^"?]+)/g)].map(m => m[1]))].filter(l => !l.includes('gift'));
    if (!links.length) continue;
    const ph = await fetchHtml('https://www.castly.co.in' + links[0]);
    if (!ph) continue;
    const imgs = [...new Set([...ph.matchAll(/https:\/\/(?:www\.)?castly\.co\.in\/cdn\/shop\/[^"'\s<>?]+\.(?:jpg|jpeg|png|webp|JPG|JPEG)/gi)].map(m => m[0]))].filter(u => !u.includes('logo'));
    if (imgs.length) return { imgs: imgs.slice(0, 4), sourcePage: 'https://www.castly.co.in' + links[0], tier: 'CASTLY' };
  }
  return null;
}

async function resolveProduct(product, spec) {
  const brand = (product.brand || '').toLowerCase();
  const name = product.name || '';
  const mfgSku = spec.manufacturerSkuCandidate || product.sku;
  const numericId = mfgSku.replace(/[^0-9]/g, '').replace(/^0+/, '') || null;
  let result = null;
  if (brand.includes('mini gt') || brand.includes('minigt')) {
    result = await scrapeKrazyCaterpillar(numericId, 'mini-gt', name);
    if (!result) result = await scrapeKrazyCaterpillar(numericId, null, name);
    if (!result) result = await scrapeMiniGT(mfgSku);
    if (!result) result = await scrapeCastly(numericId, name, 'Mini GT');
  } else if (brand.includes('hot wheels') || brand.includes('hotwheels') || brand.includes('mattel')) {
    result = await scrapeKrazyCaterpillar(numericId, 'hot-wheels', name);
    if (!result) result = await scrapeKrazyCaterpillar(numericId, null, name);
    if (!result) result = await scrapeCastly(numericId, name, 'Hot Wheels');
  } else if (brand.includes('pop race')) {
    result = await scrapeKrazyCaterpillar(numericId, 'pop-race', name);
    if (!result) result = await scrapeKrazyCaterpillar(numericId, null, name);
    if (!result) result = await scrapeCastly(numericId, name, 'Pop Race');
  } else {
    result = await scrapeKrazyCaterpillar(numericId, null, name);
    if (!result) result = await scrapeCastly(numericId, name, brand);
  }
  return result;
}

async function downloadImage(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length < 3000 ? null : buf;
  } catch { return null; }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false });
const bucketName = process.env.S3_ASSETS_BUCKET || 'gk-production-public-assets-2026';
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1', ...(process.env.AWS_ACCESS_KEY_ID ? { credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } } : {}) });

async function uploadToS3(filePath, s3Key) {
  try { await s3Client.send(new PutObjectCommand({ Bucket: bucketName, Key: s3Key, Body: fs.readFileSync(filePath), ContentType: 'image/webp' })); } catch (e) { console.warn('  S3 warn:', e.message); }
  return 'https://' + bucketName + '.s3.amazonaws.com/' + s3Key;
}

async function main() {
  const specMap = new Map();
  for (const s of lookupSpecs.products) specMap.set(s.sku, s);
  const manifest = [], unresolved = [];
  let off = 0, kk = 0, ca = 0, bl = 0, ti = 0;
  console.log('\nImage Resolution v3 -', catalog.products.length, 'products\n');
  for (let i = 0; i < catalog.products.length; i++) {
    const product = catalog.products[i];
    const spec = specMap.get(product.sku) || {};
    const sku = product.sku;
    console.log('[' + (i+1) + '/' + catalog.products.length + '] ' + sku + ' - ' + (product.name||'').slice(0,45));
    const skuDir = path.join(outputFolder, sku);
    if (!fs.existsSync(skuDir)) fs.mkdirSync(skuDir, { recursive: true });
    for (const f of fs.readdirSync(skuDir).filter(f => f.endsWith('.webp'))) fs.unlinkSync(path.join(skuDir, f));
    const scrapeResult = await resolveProduct(product, spec);
    if (!scrapeResult || !scrapeResult.imgs || !scrapeResult.imgs.length) {
      console.log('  NOT FOUND');
      unresolved.push({ sku, name: product.name, brand: product.brand });
      bl++; product.image = ''; product.images = [];
      await delay(400); continue;
    }
    const hashes = new Set(), s3Urls = [];
    let order = 1;
    for (const imgUrl of scrapeResult.imgs) {
      if (order > 4) break;
      const raw = await downloadImage(imgUrl);
      if (!raw) continue;
      const hash = crypto.createHash('md5').update(raw).digest('hex');
      if (hashes.has(hash)) continue;
      hashes.add(hash);
      let wb;
      try { wb = await sharp(raw).resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(); } catch { continue; }
      const fn = String(order).padStart(2,'0') + '.webp';
      const lp = path.join(skuDir, fn);
      const sk = 'products/' + sku + '/' + fn;
      fs.writeFileSync(lp, wb); ti++;
      manifest.push({ sku, manufacturerSku: spec.manufacturerSkuCandidate||null, sourceType: scrapeResult.tier, sourcePage: scrapeResult.sourcePage, sourceImageUrl: imgUrl, localPath: 'data/catalog-images/' + sku + '/' + fn, s3Key: sk, isPrimary: order===1, sortOrder: order });
      s3Urls.push('https://' + bucketName + '.s3.amazonaws.com/' + sk);
      order++;
    }
    if (s3Urls.length) {
      if (scrapeResult.tier==='OFFICIAL') off++; else if (scrapeResult.tier==='KARZ_OR_KRAZY') kk++; else ca++;
      product.image = s3Urls[0]; product.images = s3Urls;
      console.log('  OK [' + scrapeResult.tier + '] ' + s3Urls.length + ' img(s) - ' + scrapeResult.sourcePage.slice(0,65));
    } else {
      console.log('  DOWNLOAD FAILED');
      unresolved.push({ sku, name: product.name, brand: product.brand, reason: 'download failed' });
      bl++; product.image = ''; product.images = [];
    }
    await delay(700);
  }
  fs.writeFileSync(path.join(outputFolder, 'image-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outputFolder, 'unresolved-images.json'), JSON.stringify(unresolved, null, 2));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  console.log('\nDONE: Official=' + off + ' KK=' + kk + ' Castly=' + ca + ' Blank=' + bl + ' Images=' + ti);
  console.log('Uploading to S3 and updating DB...');
  const client = await pool.connect();
  try {
    for (const p of catalog.products) {
      const imgs = manifest.filter(m => m.sku === p.sku);
      const urls = [];
      for (const rec of imgs) { const fp = path.join(process.cwd(), '..', rec.localPath); if (fs.existsSync(fp)) urls.push(await uploadToS3(fp, rec.s3Key)); }
      const r = await client.query('UPDATE products SET image=$1, images=$2 WHERE sku=$3 RETURNING id;', [urls[0]||'', urls, p.sku]);
      if (r.rows.length) {
        const pid = r.rows[0].id;
        await client.query('DELETE FROM product_images WHERE product_id=$1;', [pid]);
        for (let idx=0; idx<urls.length; idx++) await client.query('INSERT INTO product_images (product_id,thumbnail_url,medium_url,full_url,is_primary) VALUES ($1,$2,$3,$4,$5);', [pid,urls[idx],urls[idx],urls[idx],idx===0]);
      }
    }
    console.log('DB updated!');
  } finally { client.release(); await pool.end(); }
}

main().catch(console.error);
