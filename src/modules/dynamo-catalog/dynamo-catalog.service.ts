import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';
import { CatalogProduct, DEFAULT_APP_SETTINGS } from './dynamo-catalog.types.js';

@Injectable()
export class DynamoCatalogService implements OnModuleInit {
  private readonly tableName = process.env.DYNAMODB_TABLE_NAME || 'garagekings-local';
  private readonly client: DynamoDBClient;
  private readonly document: DynamoDBDocumentClient;

  constructor() {
    const endpoint = process.env.DYNAMODB_ENDPOINT || undefined;
    this.client = new DynamoDBClient({
      region: process.env.AWS_REGION || 'ap-south-1', endpoint,
      credentials: endpoint ? { accessKeyId: 'local', secretAccessKey: 'local' } : undefined
    });
    this.document = DynamoDBDocumentClient.from(this.client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async onModuleInit() {
    if (process.env.DYNAMODB_AUTO_CREATE !== 'false') await this.ensureTable();
    const current = await this.document.send(new GetCommand({ TableName: this.tableName, Key: { pk: 'SETTINGS', sk: 'APP' } }));
    if (!current.Item) await this.document.send(new PutCommand({
      TableName: this.tableName, Item: { pk: 'SETTINGS', sk: 'APP', entity: 'SETTINGS', ...DEFAULT_APP_SETTINGS }
    }));
  }

  private async ensureTable() {
    try { await this.client.send(new DescribeTableCommand({ TableName: this.tableName })); }
    catch (error) {
      if (error?.name !== 'ResourceNotFoundException') throw error;
      try {
        await this.client.send(new CreateTableCommand({
          TableName: this.tableName, BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }]
        }));
      } catch (createError) {
        // Multiple local watch processes may reach startup together. The first
        // creates the table; the others can safely continue once it exists.
        if (createError?.name !== 'ResourceInUseException') throw createError;
      }
    }
  }

  private normalizeSku(value: unknown) { return String(value || '').trim().toUpperCase(); }
  private num(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
  private bool(value: unknown, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : Boolean(value);
  }

  private fromBody(body: any, current?: CatalogProduct): CatalogProduct {
    const now = new Date().toISOString();
    const sku = this.normalizeSku(body.sku ?? current?.sku);
    const name = String(body.name ?? body.modelName ?? current?.name ?? '').trim();
    const brand = String(body.brand ?? current?.brand ?? '').trim();
    if ((!current && !sku) || !name || !brand) throw new BadRequestException('Model ID, product name and brand are required.');
    const rawImages = body.images ?? current?.images ?? [];
    const images = Array.from(new Set((Array.isArray(rawImages) ? rawImages : [rawImages])
      .map((item: any) => typeof item === 'string' ? item : item?.url).filter(Boolean))) as string[];
    if (body.image && !images.includes(body.image)) images.unshift(body.image);
    return {
      id: current?.id || crypto.randomUUID(), sku: sku || null, brand, name,
      series: String(body.series ?? current?.series ?? '').trim() || undefined,
      scale: String(body.scale ?? current?.scale ?? '').trim() || undefined,
      casing: String(body.casing ?? body.casingType ?? current?.casing ?? '').trim() || undefined,
      category: String(body.category ?? current?.category ?? '').trim() || undefined,
      description: String(body.description ?? current?.description ?? '').trim() || undefined,
      tags: Array.from(new Set((body.tags ?? body.subtags ?? current?.tags ?? []).filter(Boolean))),
      price: this.num(body.sellingPrice ?? body.price ?? current?.price),
      purchasePrice: this.num(body.purchasePrice ?? current?.purchasePrice),
      stock: Math.max(0, Math.trunc(this.num(body.stock ?? body.availableStock ?? body.totalStock ?? current?.stock))),
      isPrebook: this.bool(body.isPrebook ?? current?.isPrebook),
      deposit: this.num(body.prebookDepositAmount ?? body.poAmount ?? body.deposit ?? current?.deposit),
      status: String(body.status ?? current?.status ?? 'Published'),
      isFeatured: this.bool(body.isFeatured ?? current?.isFeatured),
      showOnHomepage: this.bool(body.showOnHomepage ?? current?.showOnHomepage),
      customerEta: body.customerEta ?? body.arrivalDate ?? current?.customerEta ?? null,
      maxQtyPerCustomer: body.maxQtyPerCustomer ?? current?.maxQtyPerCustomer ?? null,
      images, createdAt: current?.createdAt || now, updatedAt: now, deletedAt: null
    };
  }

  private item(product: CatalogProduct) { return { pk: `PRODUCT#${product.id}`, sk: 'META', entity: 'PRODUCT', ...product }; }
  private async entityById(entity: string, id: string) {
    const result = await this.document.send(new GetCommand({ TableName: this.tableName, Key: { pk: `${entity}#${id}`, sk: 'META' } }));
    return result.Item || null;
  }

  async listEntities(entity: string) {
    const items: any[] = [];
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const result = await this.document.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'entity = :entity',
        ExpressionAttributeValues: { ':entity': entity },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      items.push(...(result.Items || []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  async saveEntity(entity: string, id: string, value: any) {
    const item = { ...value, pk: `${entity}#${id}`, sk: 'META', entity, id };
    await this.document.send(new PutCommand({ TableName: this.tableName, Item: item }));
    return item;
  }

  async getEntity(entity: string, id: string) { return this.entityById(entity, id); }

  async deleteEntity(entity: string, id: string) {
    await this.document.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `${entity}#${id}`, sk: 'META' } }));
    return { success: true };
  }

  async getUserById(id: string) {
    const user: any = await this.entityById('USER', id);
    return user && !user.deleted_at ? { id: user.id, email: user.email, role: user.role || 'Collector' } : null;
  }

  async getUserByEmail(email: string) {
    const normalized = String(email || '').trim().toLowerCase();
    const lookup = await this.document.send(new GetCommand({ TableName: this.tableName, Key: { pk: `USER_EMAIL#${normalized}`, sk: 'LOOKUP' } }));
    return lookup.Item?.userId ? this.getUserById(String(lookup.Item.userId)) : null;
  }

  async syncGoogleUser(email: string) {
    const normalized = String(email || '').trim().toLowerCase();
    const existing = await this.getUserByEmail(normalized);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const user = { pk: `USER#${id}`, sk: 'META', entity: 'USER', id, email: normalized, role: 'Collector', created_at: new Date().toISOString() };
    await this.document.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.tableName, Item: user, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: this.tableName, Item: { pk: `USER_EMAIL#${normalized}`, sk: 'LOOKUP', entity: 'USER_EMAIL_LOOKUP', userId: id }, ConditionExpression: 'attribute_not_exists(pk)' } }
    ] }));
    return { id, email: normalized, role: 'Collector' };
  }

  async setUserRole(email: string, role: string) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!['Admin', 'Collector', 'Warehouse'].includes(role)) throw new BadRequestException('Role must be Admin, Collector, or Warehouse.');
    const user = await this.getUserByEmail(normalized) || await this.syncGoogleUser(normalized);
    const current: any = await this.entityById('USER', user.id);
    await this.document.send(new PutCommand({ TableName: this.tableName, Item: { ...current, pk: `USER#${user.id}`, sk: 'META', entity: 'USER', ...user, role, updated_at: new Date().toISOString() } }));
    return { ...user, role };
  }

  async updateRefreshToken(userId: string, token: string | null) {
    const current: any = await this.entityById('USER', userId);
    if (!current) return;
    const refresh_token_hash = token ? crypto.createHash('sha256').update(token).digest('hex') : null;
    await this.document.send(new PutCommand({ TableName: this.tableName, Item: { ...current, refresh_token_hash, refresh_token_previous_hash: null, refresh_token_rotated_at: null } }));
  }

  async verifyRefreshToken(userId: string, token: string): Promise<'current' | 'previous' | null> {
    const user: any = await this.entityById('USER', userId);
    if (!user?.refresh_token_hash) return null;
    const expected = crypto.createHash('sha256').update(token).digest('hex');
    if (user.refresh_token_hash === expected) return 'current';
    const rotated = user.refresh_token_rotated_at ? new Date(user.refresh_token_rotated_at).getTime() : 0;
    return Date.now() - rotated <= 60_000 && user.refresh_token_previous_hash === expected ? 'previous' : null;
  }

  async rotateRefreshToken(userId: string, currentToken: string, newToken: string) {
    const user: any = await this.entityById('USER', userId);
    const currentHash = crypto.createHash('sha256').update(currentToken).digest('hex');
    if (!user || user.refresh_token_hash !== currentHash) return false;
    await this.document.send(new PutCommand({ TableName: this.tableName, Item: {
      ...user, refresh_token_previous_hash: user.refresh_token_hash,
      refresh_token_hash: crypto.createHash('sha256').update(newToken).digest('hex'),
      refresh_token_rotated_at: new Date().toISOString()
    } }));
    return true;
  }
  private response(product: CatalogProduct, adminMode = false) {
    const { pk: _pk, sk: _sk, entity: _entity, ...publicProduct } = product as any;
    return { ...publicProduct, image: product.images[0] || null, sellingPrice: product.price, purchasePrice: product.purchasePrice, poAmount: product.deposit,
      prebookDepositAmount: product.deposit, availableStock: product.stock, totalStock: product.stock,
      isSoldOut: product.stock <= 0, casingType: product.casing, subtags: product.tags,
      created_at: product.createdAt, ...(adminMode ? { variants: [] } : {}) };
  }

  async getSettings() {
    const result = await this.document.send(new GetCommand({ TableName: this.tableName, Key: { pk: 'SETTINGS', sk: 'APP' } }));
    const { pk: _pk, sk: _sk, entity: _entity, ...stored } = (result.Item || {}) as any;
    return { ...DEFAULT_APP_SETTINGS, ...stored };
  }
  async saveSettings(body: any) {
    const value: any = { ...(await this.getSettings()), ...body };
    delete value.pk; delete value.sk; delete value.entity;
    await this.document.send(new PutCommand({ TableName: this.tableName, Item: { pk: 'SETTINGS', sk: 'APP', entity: 'SETTINGS', ...value } }));
    return value;
  }

  async listProducts(options: any = {}) {
    const scannedProducts = await this.listEntities('PRODUCT');
    const settings = await this.getSettings();
    const search = String(options.search || '').trim().toLowerCase();
    let products = scannedProducts as CatalogProduct[];
    products = products.filter(p => !p.deletedAt);
    if (!options.adminMode) {
      products = products.filter(p => ['Published', 'Pre-Order', 'Active'].includes(p.status));
      if (settings.showSoldOutProducts === false) products = products.filter(p => p.stock > 0);
    }
    if (options.brand) products = products.filter(p => p.brand.toLowerCase() === String(options.brand).toLowerCase());
    if (options.scale) products = products.filter(p => p.scale === options.scale);
    if (options.tag) products = products.filter(p => p.tags?.includes(options.tag));
    if (options.inStock) products = products.filter(p => p.stock > 0 && !p.isPrebook);
    if (options.preBooking) products = products.filter(p => p.isPrebook);
    if (options.featured !== undefined) products = products.filter(p => p.isFeatured === options.featured);
    if (search) products = products.filter(p => [p.name, p.brand, p.series, p.sku].some(v => String(v || '').toLowerCase().includes(search)));
    products.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = Math.max(1, Math.min(options.adminMode ? 100 : 50, Number(options.limit) || (options.adminMode ? 10 : 12)));
    const page = Math.max(1, Number(options.page) || 1);
    const offset = options.offset === undefined ? (page - 1) * limit : Math.max(0, Number(options.offset) || 0);
    const total = products.length;
    return { products: products.slice(offset, offset + limit).map(p => this.response(p, options.adminMode)), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async getProduct(id: string, adminMode = false) {
    const result = await this.document.send(new GetCommand({ TableName: this.tableName, Key: { pk: `PRODUCT#${id}`, sk: 'META' } }));
    const product = result.Item as CatalogProduct | undefined;
    if (!product || product.deletedAt) return null;
    if (!adminMode && (await this.getSettings()).showSoldOutProducts === false && product.stock <= 0) return null;
    return this.response(product, adminMode);
  }

  async checkSku(sku: string, excludeId?: string) {
    const normalized = this.normalizeSku(sku);
    const result = await this.document.send(new GetCommand({ TableName: this.tableName, Key: { pk: `SKU#${normalized}`, sk: 'LOCK' } }));
    const conflict = result.Item && result.Item.productId !== excludeId ? result.Item : null;
    return { available: !conflict, sku: normalized, conflict: conflict ? { productId: conflict.productId, productName: conflict.productName } : null };
  }

  async createProduct(body: any) {
    const product = this.fromBody(body);
    try { await this.document.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.tableName, Item: this.item(product), ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: this.tableName, Item: { pk: `SKU#${product.sku}`, sk: 'LOCK', entity: 'SKU_LOCK', productId: product.id, productName: product.name }, ConditionExpression: 'attribute_not_exists(pk)' } }
    ] })); } catch (error) {
      if (error?.name === 'TransactionCanceledException') throw new ConflictException(`Model ID "${product.sku}" is already in use.`);
      throw error;
    }
    return this.response(product, true);
  }

  async updateProduct(id: string, body: any) {
    const current: any = await this.getProduct(id, true);
    if (!current) throw new NotFoundException('Product not found.');
    const product = this.fromBody(body, current);
    const writes: any[] = [{ Put: { TableName: this.tableName, Item: this.item(product), ConditionExpression: 'attribute_exists(pk)' } }];
    if (product.sku !== current.sku) {
      if (current.sku) writes.push({ Delete: { TableName: this.tableName, Key: { pk: `SKU#${current.sku}`, sk: 'LOCK' } } });
      if (product.sku) writes.push({ Put: { TableName: this.tableName, Item: { pk: `SKU#${product.sku}`, sk: 'LOCK', entity: 'SKU_LOCK', productId: id, productName: product.name }, ConditionExpression: 'attribute_not_exists(pk)' } });
    }
    try { await this.document.send(new TransactWriteCommand({ TransactItems: writes })); }
    catch (error) {
      if (error?.name === 'TransactionCanceledException') throw new ConflictException(`Model ID "${product.sku}" is already in use.`);
      throw error;
    }
    return this.response(product, true);
  }

  async deleteProduct(id: string) {
    const current: any = await this.getProduct(id, true);
    if (!current) throw new NotFoundException('Product not found.');
    const deletes: any[] = [{ Delete: { TableName: this.tableName, Key: { pk: `PRODUCT#${id}`, sk: 'META' } } }];
    if (current.sku) deletes.push({ Delete: { TableName: this.tableName, Key: { pk: `SKU#${current.sku}`, sk: 'LOCK' } } });
    await this.document.send(new TransactWriteCommand({ TransactItems: deletes }));
    return { success: true };
  }

  async getLookups() {
    const result = await this.listProducts({ adminMode: true, limit: 250 });
    const unique = (values: any[]) => {
      const seen = new Set<string>();
      return values
        .flatMap(value => Array.isArray(value) ? value : [value])
        .map(value => String(value ?? '').trim())
        .filter(value => {
          const key = value.toLocaleLowerCase();
          if (!value || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((left, right) => left.localeCompare(right));
    };
    const [brands, scales, series, categories, tags, suppliers] = await Promise.all(
      ['BRAND', 'SCALE', 'SERIES', 'CATEGORY', 'TAG', 'SUPPLIER'].map(entity => this.listEntities(entity))
    );
    return {
      brands: unique([...brands.map((v: any) => v.name), ...result.products.map((p: any) => p.brand)]),
      scales: unique([...scales.map((v: any) => v.name), ...result.products.map((p: any) => p.scale)]),
      series: unique([...series.map((v: any) => v.name), ...result.products.map((p: any) => p.series)]),
      casingTypes: unique(['Box', 'Blister', 'Acrylic casing', ...result.products.flatMap((p: any) => p.casingTypes || p.casing || [])]),
      categories: unique(['Die-cast', ...categories.map((v: any) => v.name), ...result.products.map((p: any) => p.category)]),
      tags: unique([
        ...tags.map((v: any) => v.name),
        ...result.products.flatMap((p: any) => [p.tags || [], p.tag, p.grade, p.lane]),
      ]),
      suppliers: unique([...suppliers.map((v: any) => v.name), ...result.products.map((p: any) => p.supplier)])
    };
  }
}
