import 'dotenv/config';
import pg from 'pg';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const tableName = process.env.DYNAMODB_TABLE_NAME || 'garagekings-local';
const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1', endpoint,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const document = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

try { await client.send(new DescribeTableCommand({ TableName: tableName })); }
catch (error) {
  if (error.name !== 'ResourceNotFoundException') throw error;
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }));
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false });
const { rows } = await pool.query(`
  SELECT id, sku, brand, model_name AS name, series, scale, casing, category, description,
    COALESCE(tags, subtags, ARRAY[]::text[]) AS tags,
    COALESCE(selling_price, base_price, price, 0) AS price,
    COALESCE(purchase_price, 0) AS purchase_price,
    COALESCE(stock, available_stock, total_stock, 0) AS stock,
    COALESCE(is_prebook, false) AS is_prebook,
    COALESCE(prebook_deposit_amount, po_amount, 0) AS deposit,
    COALESCE(status, 'Published') AS status,
    COALESCE(is_featured, false) AS is_featured,
    COALESCE(show_on_homepage, false) AS show_on_homepage,
    customer_eta, max_qty_per_customer,
    COALESCE(images, CASE WHEN image IS NULL THEN ARRAY[]::text[] ELSE ARRAY[image] END) AS images,
    created_at, updated_at
  FROM products WHERE deleted_at IS NULL
`);

const requests = rows.flatMap(row => {
  const product = {
    pk: `PRODUCT#${row.id}`, sk: 'META', entity: 'PRODUCT', id: row.id,
    sku: String(row.sku || '').trim().toUpperCase() || null, brand: row.brand, name: row.name,
    series: row.series || undefined, scale: row.scale || undefined, casing: row.casing || undefined,
    category: row.category || undefined, description: row.description || undefined, tags: row.tags || [],
    price: Number(row.price || 0), purchasePrice: Number(row.purchase_price || 0), stock: Math.max(0, Number(row.stock || 0)),
    isPrebook: Boolean(row.is_prebook), deposit: Number(row.deposit || 0), status: row.status,
    isFeatured: Boolean(row.is_featured), showOnHomepage: Boolean(row.show_on_homepage),
    customerEta: row.customer_eta || null, maxQtyPerCustomer: row.max_qty_per_customer || null,
    images: (row.images || []).filter(Boolean), createdAt: row.created_at?.toISOString?.() || new Date().toISOString(),
    updatedAt: row.updated_at?.toISOString?.() || new Date().toISOString(), deletedAt: null
  };
  const writes = [{ PutRequest: { Item: product } }];
  if (product.sku) writes.push({ PutRequest: { Item: { pk: `SKU#${product.sku}`, sk: 'LOCK', entity: 'SKU_LOCK', productId: product.id, productName: product.name } } });
  return writes;
});

const activeTables = [
  ['users', 'USER', 'WHERE deleted_at IS NULL'],
  ['customers', 'CUSTOMER', 'WHERE deleted_at IS NULL'],
  ['orders', 'ORDER', 'WHERE deleted_at IS NULL'],
  ['order_items', 'ORDER_ITEM', ''],
  ['suppliers', 'SUPPLIER', ''],
  ['inventory_batches', 'INVENTORY_BATCH', ''],
  ['inventory_ledger', 'INVENTORY_LEDGER', ''],
  ['audit_logs', 'AUDIT_LOG', ''],
  ['performance_metrics', 'PERFORMANCE_METRIC', ''],
  ['product_variants', 'PRODUCT_VARIANT', 'WHERE deleted_at IS NULL'],
  ['product_images', 'PRODUCT_IMAGE', ''],
  ['catalog_prices', 'CATALOG_PRICE', '']
];

const importedCounts = { products: rows.length };
for (const [sourceTable, entity, whereClause] of activeTables) {
  const result = await pool.query(`SELECT * FROM ${sourceTable} ${whereClause}`);
  importedCounts[sourceTable] = result.rows.length;
  for (const source of result.rows) {
    const item = Object.fromEntries(Object.entries(source).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value
    ]));
    // Google is the only login method. Password hashes are intentionally not
    // copied into the new datastore.
    delete item.password_hash;
    const id = String(item.id);
    requests.push({ PutRequest: { Item: {
      pk: `${entity}#${id}`, sk: 'META', entity, id,
      sourceTable, ...item
    } } });
    if (entity === 'USER' && item.email) {
      requests.push({ PutRequest: { Item: {
        pk: `USER_EMAIL#${String(item.email).trim().toLowerCase()}`,
        sk: 'LOOKUP', entity: 'USER_EMAIL_LOOKUP', userId: id
      } } });
    }
  }
}

for (let index = 0; index < requests.length; index += 25) {
  let pending = requests.slice(index, index + 25);
  do {
    const result = await document.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
    pending = result.UnprocessedItems?.[tableName] || [];
    if (pending.length) await new Promise(resolve => setTimeout(resolve, 100));
  } while (pending.length);
}
await document.send(new PutCommand({ TableName: tableName, Item: { pk: 'SETTINGS', sk: 'APP', entity: 'SETTINGS',
  showSoldOutProducts: true, marketplaceMobileInitialPageSize: 5, marketplaceDesktopInitialPageSize: 12 } }));
await pool.end();
console.log(`Imported active PostgreSQL data into ${tableName}:`);
console.table(importedCounts);
