import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import pkg from 'pg';
import { validateImageMatch } from './image-match-validation.mjs';

const { Pool } = pkg;
dotenv.config({ path: path.join(process.cwd(), '.env') });

const apply = process.argv.includes('--apply');
const root = path.join(process.cwd(), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data', 'garagekings_marketplace_catalog_v2.json'), 'utf8'));
const lookup = JSON.parse(fs.readFileSync(path.join(root, 'data', 'garagekings_image_lookup_manifest.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'catalog-images', 'image-manifest.json'), 'utf8'));

const productBySku = new Map(catalog.products.map(product => [product.sku, product]));
const lookupBySku = new Map(lookup.products.map(spec => [spec.sku, spec]));
const firstImageBySku = new Map();
for (const record of manifest) {
  if (!firstImageBySku.has(record.sku)) firstImageBySku.set(record.sku, record);
}

const audit = [];
for (const [sku, record] of firstImageBySku) {
  const product = productBySku.get(sku);
  if (!product) continue;
  const result = validateImageMatch(product, record, lookupBySku.get(sku)?.manufacturerSkuCandidate);
  audit.push({ sku, brand: product.brand, name: product.name, valid: result.valid, reason: result.reason, sourcePage: record.sourcePage });
}

const invalid = audit.filter(row => !row.valid);
console.table(audit.map(({ sku, name, valid, reason }) => ({ sku, name, valid, reason })));
console.log(`Validated: ${audit.length - invalid.length}; rejected: ${invalid.length}; manifest SKUs audited: ${audit.length}.`);

if (!apply) {
  console.log('Dry run only. Use --apply to remove rejected image links from the database after reviewing this report.');
  process.exit(0);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const skus = invalid.map(row => row.sku);
  const existing = await client.query(`
    SELECT p.id, p.sku, p.image, p.images,
           COALESCE(json_agg(pi.*) FILTER (WHERE pi.id IS NOT NULL), '[]') as product_images
    FROM products p
    LEFT JOIN product_images pi ON pi.product_id = p.id
    WHERE p.sku = ANY($1::text[])
    GROUP BY p.id, p.sku, p.image, p.images;
  `, [skus]);

  const backupPath = path.join(root, 'data', 'catalog-images', `image-link-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(existing.rows, null, 2));

  await client.query('DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE sku = ANY($1::text[]));', [skus]);
  await client.query("UPDATE products SET image = '', images = ARRAY[]::text[] WHERE sku = ANY($1::text[]);", [skus]);
  await client.query('COMMIT');
  console.log(`Removed rejected image links for ${skus.length} SKUs. Backup: ${backupPath}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
