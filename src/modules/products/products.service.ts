import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { localCache } from '../api/api.helpers.js';

@Injectable()
export class ProductsService {
  constructor(private readonly dataSource: DataSource) {}

  async checkSkuAvailability(sku: string, excludeId?: string) {
    const normalizedSku = String(sku || '').trim().toUpperCase();
    if (!normalizedSku) return { available: false, sku: normalizedSku };

    const params: any[] = [normalizedSku];
    let productExclusion = '';
    if (excludeId) {
      params.push(excludeId);
      productExclusion = 'AND p.id <> $2';
    }

    const rows = await this.dataSource.query(`
      SELECT p.id, p.sku, p.model_name AS name
      FROM products p
      WHERE UPPER(TRIM(p.sku)) = $1
        AND p.deleted_at IS NULL
        ${productExclusion}

      LIMIT 1;
    `, params);

    const conflict = rows[0];
    return {
      available: !conflict,
      sku: normalizedSku,
      conflict: conflict ? {
        productId: conflict.id,
        productName: conflict.name
      } : null
    };
  }

  async getProducts(adminMode = false) {
    const cacheKey = `products_list_${adminMode}`;
    const cached = localCache.get(cacheKey);
    if (cached) return cached;

    const selectFields = adminMode
      ? `id, sku, brand, model_name as name, series, scale, casing, tag, subtags, status,
         category, description, tags, supplier, max_qty_per_customer as "maxQtyPerCustomer",
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(purchase_price, 0.00) as "purchasePrice",
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         COALESCE(stock, total_stock, 0)::int as "availableStock",
         is_prebook as "isPrebook", is_featured as "isFeatured", show_on_homepage as "showOnHomepage",
         COALESCE(customer_eta, arrival_date) as "customerEta", arrival_date as "arrivalDate", release_date as "releaseDate",
         image, images, created_at`
      : `id, sku, brand, model_name as name, series, scale, casing, tag, subtags,
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         (COALESCE(available_stock, stock, total_stock, 0) <= 0) as "isSoldOut",
         is_prebook as "isPrebook", is_featured as "isFeatured",
         COALESCE(customer_eta, arrival_date) as "customerEta",
         image, created_at`;

    const settingsRows = adminMode ? [] : await this.dataSource.query("SELECT value FROM global_settings WHERE key = 'app_settings';");
    const showSoldOutProducts = settingsRows[0]?.value?.showSoldOutProducts !== false;
    const queryStr = `
      SELECT ${selectFields}
      FROM products
      WHERE deleted_at IS NULL
      ${adminMode ? '' : `AND (status IN ('Published', 'Pre-Order', 'Active') OR status IS NULL)
        ${showSoldOutProducts ? '' : 'AND COALESCE(available_stock, stock, total_stock, 0) > 0'}`}
      ORDER BY created_at DESC;
    `;

    const rows = await this.dataSource.query(queryStr);
    localCache.set(cacheKey, rows, 10);
    return rows;
  }

  async getPaginatedProducts(options: {
    page?: number;
    limit?: number;
    offset?: number;
    brand?: string;
    scale?: string;
    tag?: string;
    search?: string;
    inStock?: boolean;
    preBooking?: boolean;
    featured?: boolean;
    adminMode?: boolean;
    userAgent?: string;
  }) {
    const settingsCacheKey = 'public_product_page_settings';
    let settings = localCache.get(settingsCacheKey);
    if (!settings) {
      const rowsSettings = await this.dataSource.query("SELECT value FROM global_settings WHERE key = 'app_settings';");
      settings = rowsSettings.length > 0 ? rowsSettings[0].value : {};
      localCache.set(settingsCacheKey, settings, 60);
    }
    const isMobile = options.userAgent ? /mobi|android|iphone|ipad|phone/i.test(options.userAgent) : false;
    const defaultPageSize = isMobile 
      ? (settings.marketplaceMobileInitialPageSize || 5) 
      : (settings.marketplaceDesktopInitialPageSize || 12);

    const maxLimit = options.adminMode ? 100 : 50;
    const rawLimit = Number(options.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(maxLimit, rawLimit) : (options.adminMode ? 10 : defaultPageSize);
    const rawPage = Number(options.page);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const offset = options.offset !== undefined && Number.isFinite(Number(options.offset)) 
      ? Math.max(0, Number(options.offset)) 
      : (page - 1) * limit;

    const selectFields = options.adminMode
      ? `id, sku, brand, model_name as name, series, scale, casing, tag, subtags, status,
         category, description, tags, supplier, max_qty_per_customer as "maxQtyPerCustomer",
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(purchase_price, 0.00) as "purchasePrice",
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         COALESCE(stock, total_stock, 0)::int as "availableStock",
         is_prebook as "isPrebook", is_featured as "isFeatured", show_on_homepage as "showOnHomepage",
         COALESCE(customer_eta, arrival_date) as "customerEta", arrival_date as "arrivalDate", release_date as "releaseDate",
         image, created_at`
      : `id, sku, brand, model_name as name, series, scale, casing, tag, subtags,
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         (COALESCE(available_stock, stock, total_stock, 0) <= 0) as "isSoldOut",
         is_prebook as "isPrebook", is_featured as "isFeatured",
         COALESCE(customer_eta, arrival_date) as "customerEta",
         image, created_at`;

    let queryStr = `
      SELECT ${selectFields}
      FROM products
      WHERE deleted_at IS NULL
    `;

    if (!options.adminMode) {
      queryStr += ` AND (status IN ('Published', 'Pre-Order', 'Active') OR status IS NULL)`;
      if (settings.showSoldOutProducts === false) {
        queryStr += ` AND COALESCE(available_stock, stock, total_stock, 0) > 0`;
      }
    }

    const params: any[] = [];
    let paramIndex = 1;

    if (options.brand) {
      queryStr += ` AND LOWER(brand) = LOWER($${paramIndex})`;
      params.push(options.brand);
      paramIndex++;
    }

    if (options.scale) {
      queryStr += ` AND scale = $${paramIndex}`;
      params.push(options.scale);
      paramIndex++;
    }

    if (options.tag) {
      queryStr += ` AND $${paramIndex} = ANY(subtags)`;
      params.push(options.tag);
      paramIndex++;
    }

    const searchTrimmed = typeof options.search === 'string' ? options.search.trim() : '';
    if (searchTrimmed.length > 0) {
      queryStr += ` AND (
        LOWER(model_name) LIKE LOWER($${paramIndex}) OR
        LOWER(brand) LIKE LOWER($${paramIndex}) OR
        LOWER(series) LIKE LOWER($${paramIndex}) OR
        LOWER(sku) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${searchTrimmed}%`);
      paramIndex++;
    }

    if (options.inStock) {
      // In Stock = has physical stock AND is NOT a pre-order/pre-book item
      queryStr += ` AND COALESCE(stock, total_stock, 0) > 0 AND (is_prebook IS NULL OR is_prebook = false) AND status != 'Pre-Order'`;
    }

    if (options.preBooking) {
      queryStr += ` AND (is_prebook = true OR status = 'Pre-Order')`;
    }

    if (options.featured !== undefined) {
      queryStr += ` AND is_featured = $${paramIndex}`;
      params.push(Boolean(options.featured));
      paramIndex++;
    }

    const countQuery = `SELECT COUNT(*)::int as total FROM (${queryStr}) as sub`;
    const dataQuery = `${queryStr} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    const dataParams = [...params, limit, offset];
    const [countRows, rows] = await Promise.all([
      this.dataSource.query(countQuery, params),
      this.dataSource.query(dataQuery, dataParams)
    ]);
    const total = parseInt(countRows[0]?.total || '0', 10);

    return {
      products: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  async getProduct(id: string, adminMode = false) {
    const cacheKey = `product_${id}_${adminMode}`;
    const cached = localCache.get(cacheKey);
    if (cached) return cached;

    const queryStr = `
      SELECT id, sku, brand, model_name as name, series, scale, casing,
             casing as "casingType", description, tag, subtags, tags, category,
             status, show_on_homepage as "showOnHomepage", is_featured as "isFeatured",
             max_qty_per_customer as "maxQtyPerCustomer",
             COALESCE(selling_price, base_price, 0.00) as "sellingPrice",
             COALESCE(selling_price, base_price, 0.00) as price,
             COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
             COALESCE(po_amount, prebook_deposit_amount, 0.00) as "prebookDepositAmount",
             COALESCE(
               available_stock,
               stock,
               total_stock - COALESCE(locked_stock, 0) - COALESCE(sold_stock, 0),
               total_stock,
               0
             )::int as "availableStock",
             COALESCE(
               available_stock,
               stock,
               total_stock - COALESCE(locked_stock, 0) - COALESCE(sold_stock, 0),
               total_stock,
               0
             )::int as stock,
             is_prebook as "isPrebook", customer_eta as "customerEta",
             arrival_date as "arrivalDate", release_date as "releaseDate",
             image, images, created_at
      FROM products
      WHERE deleted_at IS NULL AND id = $1
      LIMIT 1;
    `;

    const rows = await this.dataSource.query(queryStr, [id]);
    if (rows.length === 0) return null;

    const product = rows[0];

    if (!adminMode) {
      const settingsRows = await this.dataSource.query("SELECT value FROM global_settings WHERE key = 'app_settings';");
      const settings = settingsRows[0]?.value || {};
      const soldOut = Number(product.availableStock || 0) <= 0;
      if (settings.showSoldOutProducts === false && soldOut) return null;
    }

    localCache.set(cacheKey, product, 10);
    return product;
  }

  async getBackupImageReferences(productIds: string[]): Promise<Record<string, string[]>> {
    if (!Array.isArray(productIds) || productIds.length === 0) return {};
    const rows = await this.dataSource.query(`
      SELECT product_id AS "productId",
             COALESCE(full_url, medium_url, thumbnail_url) AS url
      FROM product_images
      WHERE product_id = ANY($1::uuid[])
      ORDER BY product_id, is_primary DESC, created_at ASC;
    `, [productIds]);
    return rows.reduce((grouped: Record<string, string[]>, row: any) => {
      const productId = String(row.productId || '');
      const url = String(row.url || '').trim();
      if (!productId || !url) return grouped;
      if (!grouped[productId]) grouped[productId] = [];
      if (!grouped[productId].includes(url)) grouped[productId].push(url);
      return grouped;
    }, {});
  }
}
