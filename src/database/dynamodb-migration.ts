import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DataSource } from 'typeorm';

const region = () => process.env.AWS_REGION || 'ap-south-1';
const tableName = () => process.env.DYNAMODB_TABLE_NAME || 'garagekings-production';

function clients() {
  const endpoint = process.env.DYNAMODB_ENDPOINT || undefined;
  const client = new DynamoDBClient({
    region: region(),
    endpoint,
    credentials: endpoint ? { accessKeyId: 'local', secretAccessKey: 'local' } : undefined,
  });
  return { client, document: DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } }) };
}

function serializable(value: any): any {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializable);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, serializable(entry)]));
}

const first = (row: any, ...keys: string[]) => keys.map(key => row?.[key]).find(value => value !== undefined && value !== null);
const number = (row: any, ...keys: string[]) => Number(first(row, ...keys) || 0);
const boolean = (row: any, ...keys: string[]) => Boolean(first(row, ...keys));

async function tableExists(database: DataSource, name: string) {
  const rows = await database.query(`SELECT to_regclass($1) AS table_name`, [`public.${name}`]);
  return Boolean(rows[0]?.table_name);
}

async function rows(database: DataSource, name: string, activeOnly = false) {
  if (!(await tableExists(database, name))) return [];
  if (!activeOnly) return database.query(`SELECT * FROM public.${name}`);
  const columns = await database.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [name]);
  const hasDeletedAt = columns.some((column: any) => column.column_name === 'deleted_at');
  return database.query(`SELECT * FROM public.${name}${hasDeletedAt ? ' WHERE deleted_at IS NULL' : ''}`);
}

async function ensureTable(client: DynamoDBClient) {
  try { await client.send(new DescribeTableCommand({ TableName: tableName() })); }
  catch (error: any) {
    if (error?.name !== 'ResourceNotFoundException') throw error;
    await client.send(new CreateTableCommand({
      TableName: tableName(), BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      SSESpecification: { Enabled: true },
    }));
    await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: tableName() });
  }
}

async function writeAll(document: DynamoDBDocumentClient, items: any[]) {
  for (let index = 0; index < items.length; index += 25) {
    let pending: any[] = items.slice(index, index + 25).map(Item => ({ PutRequest: { Item: serializable(Item) } }));
    do {
      const result = await document.send(new BatchWriteCommand({ RequestItems: { [tableName()]: pending } }));
      pending = result.UnprocessedItems?.[tableName()] || [];
      if (pending.length) await new Promise(resolve => setTimeout(resolve, 150));
    } while (pending.length);
  }
}

export async function migratePostgresToDynamo(database: DataSource) {
  const { client, document } = clients();
  await ensureTable(client);

  const [products, productImages, receiptRows, receiptItems] = await Promise.all([
    rows(database, 'products', true), rows(database, 'product_images'), rows(database, 'receipts'), rows(database, 'receipt_items'),
  ]);
  const imagesByProduct = new Map<string, any[]>();
  for (const image of productImages) {
    const key = String(image.product_id || '');
    if (!imagesByProduct.has(key)) imagesByProduct.set(key, []);
    imagesByProduct.get(key)!.push(image);
  }
  const itemsByReceipt = new Map<string, any[]>();
  for (const item of receiptItems) {
    const key = String(item.receipt_id || '');
    if (!itemsByReceipt.has(key)) itemsByReceipt.set(key, []);
    itemsByReceipt.get(key)!.push({ ...serializable(item), quantity: Number(item.qty || item.quantity || 1), unitAmount: Number(item.amount || 0) });
  }

  const output: any[] = [];
  for (const source of products) {
    const id = String(source.id);
    const sku = String(first(source, 'sku') || '').trim().toUpperCase();
    const imageRows = (imagesByProduct.get(id) || []).sort((left, right) => Number(right.is_primary) - Number(left.is_primary) || Number(left.display_order) - Number(right.display_order));
    const imageReferences = [first(source, 'image'), ...imageRows.flatMap(image => [image.url, image.thumbnail_url])]
      .map(value => String(value || '').trim()).filter(Boolean);
    const images = Array.from(new Set(imageReferences));
    const product = {
      pk: `PRODUCT#${id}`, sk: 'META', entity: 'PRODUCT', id, sku,
      brand: first(source, 'brand') || '', name: first(source, 'model_name', 'name') || '',
      series: first(source, 'series'), scale: first(source, 'scale'), casing: first(source, 'casing', 'casing_type'),
      category: first(source, 'category'), description: first(source, 'description') || '',
      tags: first(source, 'tags', 'subtags') || [], tag: first(source, 'tag', 'grade', 'lane'),
      price: number(source, 'selling_price', 'base_price', 'price'), purchasePrice: number(source, 'purchase_price'),
      stock: Math.max(0, number(source, 'stock', 'available_stock', 'total_stock')),
      isPrebook: boolean(source, 'is_prebook'), deposit: number(source, 'prebook_deposit_amount', 'po_amount'),
      status: first(source, 'status') || 'Published', isFeatured: boolean(source, 'is_featured'),
      showOnHomepage: boolean(source, 'show_on_homepage'), isPublic: first(source, 'is_public') !== false,
      customerEta: first(source, 'customer_eta') || null, maxQtyPerCustomer: first(source, 'max_qty_per_customer') || null,
      supplier: first(source, 'supplier') || '', images, createdAt: first(source, 'created_at') || new Date().toISOString(),
      updatedAt: first(source, 'updated_at') || new Date().toISOString(), deletedAt: null,
    };
    output.push(product);
    if (sku) output.push({ pk: `SKU#${sku}`, sk: 'LOCK', entity: 'SKU_LOCK', productId: id, productName: product.name });
  }

  for (const source of receiptRows) {
    const id = String(source.id);
    output.push({
      ...serializable(source), pk: `RECEIPT#${id}`, sk: 'META', entity: 'RECEIPT', id,
      receiptNumber: source.receipt_number, customerName: source.customer_name,
      customerPhone: source.customer_phone || 'Not provided', customerEmail: source.customer_email,
      customerAddress: source.customer_address, customerInstagram: source.customer_instagram,
      formatType: source.format_type, taxPercent: number(source, 'tax_percent'), taxAmount: number(source, 'tax_amount'),
      shippingCharges: number(source, 'shipping_charges'), totalAmount: number(source, 'total_amount'),
      advancePaid: number(source, 'advance_paid'), pendingBalance: number(source, 'pending_balance'),
      footerNote: source.footer_note, pdfUrl: source.pdf_url, receiptDate: source.created_at,
      items: itemsByReceipt.get(id) || [],
    });
  }

  const entityTables: Array<[string, string, boolean]> = [
    ['users', 'USER', true], ['customers', 'CUSTOMER', true], ['orders', 'ORDER', true], ['order_items', 'ORDER_ITEM', false],
    ['suppliers', 'SUPPLIER', false], ['inventory_batches', 'INVENTORY_BATCH', false], ['inventory_ledger', 'INVENTORY_LEDGER', false],
    ['product_variants', 'PRODUCT_VARIANT', true], ['catalog_prices', 'CATALOG_PRICE', false],
    ['brands', 'BRAND', true], ['manufacturers', 'MANUFACTURER', true], ['scales', 'SCALE', true], ['series', 'SERIES', true],
    ['categories', 'CATEGORY', true], ['tags', 'TAG', true], ['payment_methods', 'PAYMENT_METHOD', true], ['shipping_providers', 'SHIPPING_PROVIDER', true],
  ];
  const counts: Record<string, number> = { products: products.length, receipts: receiptRows.length };
  for (const [sourceTable, entity, activeOnly] of entityTables) {
    const sourceRows = await rows(database, sourceTable, activeOnly);
    counts[sourceTable] = sourceRows.length;
    for (const source of sourceRows) {
      const id = String(source.id);
      const item: any = { ...serializable(source), pk: `${entity}#${id}`, sk: 'META', entity, id, sourceTable };
      delete item.password_hash;
      output.push(item);
      if (entity === 'USER' && source.email) output.push({
        pk: `USER_EMAIL#${String(source.email).trim().toLowerCase()}`, sk: 'LOOKUP', entity: 'USER_EMAIL_LOOKUP', userId: id,
      });
    }
  }

  let settings: any = {};
  if (await tableExists(database, 'global_settings')) {
    const result = await database.query(`SELECT value FROM public.global_settings WHERE key='app_settings' LIMIT 1`);
    settings = result[0]?.value || {};
  }
  output.push({ pk: 'SETTINGS', sk: 'APP', entity: 'SETTINGS', ...settings });
  await writeAll(document, output);

  const scan = await document.send(new ScanCommand({ TableName: tableName(), Select: 'COUNT' }));
  return { tableName: tableName(), counts, writtenItems: output.length, verifiedItems: scan.Count || 0 };
}
