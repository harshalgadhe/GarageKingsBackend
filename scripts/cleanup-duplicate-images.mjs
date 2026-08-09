import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import pkg from 'pg';

const { Pool } = pkg;
dotenv.config({ path: path.join(process.cwd(), '.env') });
const apply = process.argv.includes('--apply');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
});
const client = await pool.connect();

const canonicalSql = `LOWER(REGEXP_REPLACE(COALESCE(NULLIF(full_url, ''), NULLIF(medium_url, ''), NULLIF(thumbnail_url, '')), '[?#].*$', ''))`;

try {
  const duplicateRows = await client.query(`
    WITH ranked AS (
      SELECT pi.*,
             ${canonicalSql} AS canonical_url,
             ROW_NUMBER() OVER (
               PARTITION BY product_id, ${canonicalSql}
               ORDER BY is_primary DESC NULLS LAST, created_at ASC, id ASC
             ) AS duplicate_rank
      FROM product_images pi
      WHERE COALESCE(NULLIF(full_url, ''), NULLIF(medium_url, ''), NULLIF(thumbnail_url, '')) IS NOT NULL
    )
    SELECT * FROM ranked WHERE duplicate_rank > 1 ORDER BY product_id, canonical_url;
  `);

  const products = await client.query(`
    SELECT id, sku, image, images
    FROM products
    WHERE deleted_at IS NULL AND COALESCE(array_length(images, 1), 0) > 1;
  `);
  const arrayChanges = products.rows.map((product) => {
    const seen = new Set();
    const unique = (product.images || []).filter((url) => {
      const key = String(url || '').trim().replace(/[?#].*$/, '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...product, unique, removed: (product.images || []).length - unique.length };
  }).filter((product) => product.removed > 0);

  const crossProductRows = await client.query(`
    WITH image_owners AS (
      SELECT pi.*, p.sku, p.model_name,
             ${canonicalSql} AS canonical_url
      FROM product_images pi
      JOIN products p ON p.id = pi.product_id
      WHERE p.deleted_at IS NULL
        AND COALESCE(NULLIF(full_url, ''), NULLIF(medium_url, ''), NULLIF(thumbnail_url, '')) IS NOT NULL
    ), duplicate_urls AS (
      SELECT canonical_url, COUNT(DISTINCT product_id)::int AS product_count
      FROM image_owners
      GROUP BY canonical_url
      HAVING COUNT(DISTINCT product_id) > 1
    )
    SELECT image_owners.*, duplicate_urls.product_count
    FROM image_owners
    JOIN duplicate_urls USING (canonical_url)
    ORDER BY canonical_url, sku;
  `);

  const crossProductRemovals = crossProductRows.rows.filter((row) => {
    const normalizedUrl = row.canonical_url.toLowerCase();
    return !normalizedUrl.includes(`/products/${String(row.sku).toLowerCase()}/`);
  });

  console.log(`Duplicate product_images rows: ${duplicateRows.rowCount}`);
  console.log(`Products with duplicate image-array URLs: ${arrayChanges.length}`);
  console.log(`Cross-product image associations: ${crossProductRows.rowCount}; safely attributable removals: ${crossProductRemovals.length}`);
  if (duplicateRows.rowCount) console.table(duplicateRows.rows.map((row) => ({ productId: row.product_id, duplicateId: row.id, url: row.canonical_url })));
  if (arrayChanges.length) console.table(arrayChanges.map((row) => ({ sku: row.sku, removed: row.removed, remaining: row.unique.length })));
  if (crossProductRows.rowCount) console.table(crossProductRows.rows.map((row) => ({ sku: row.sku, model: row.model_name, url: row.canonical_url, ownsPath: row.canonical_url.toLowerCase().includes(`/products/${String(row.sku).toLowerCase()}/`) })));

  if (!apply) {
    console.log('Dry run only. Use --apply to back up and remove exact duplicates.');
    process.exitCode = 0;
  } else {
    await client.query('BEGIN');
    const backupDir = path.join(process.cwd(), 'data', 'image-cleanup-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `duplicate-images-${Date.now()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ productImageRows: duplicateRows.rows, productArrays: arrayChanges, crossProductRows: crossProductRows.rows }, null, 2));

    if (duplicateRows.rowCount) {
      await client.query('DELETE FROM product_images WHERE id = ANY($1::uuid[])', [duplicateRows.rows.map((row) => row.id)]);
    }
    if (crossProductRemovals.length) {
      await client.query('DELETE FROM product_images WHERE id = ANY($1::uuid[])', [crossProductRemovals.map((row) => row.id)]);
    }
    for (const product of arrayChanges) {
      await client.query('UPDATE products SET images = $2::text[], updated_at = NOW() WHERE id = $1', [product.id, product.unique]);
    }
    await client.query('COMMIT');
    console.log(`Removed ${duplicateRows.rowCount + crossProductRemovals.length + arrayChanges.reduce((sum, row) => sum + row.removed, 0)} duplicate associations. Backup: ${backupPath}`);
  }
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
