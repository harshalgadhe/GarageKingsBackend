import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { localCache } from '../api/api.helpers.js';

@Injectable()
export class ProductsService {
  constructor(private readonly dataSource: DataSource) {}

  async getProducts(adminMode = false) {
    const cacheKey = `products_list_${adminMode}`;
    const cached = localCache.get(cacheKey);
    if (cached) return cached;

    const selectFields = adminMode
      ? `id, sku, brand, model_name as name, series, scale, casing, tag, subtags, status,
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         COALESCE(stock, total_stock, 0)::int as "availableStock",
         is_prebook as "isPrebook",
         COALESCE(customer_eta, arrival_date) as "customerEta",
         image, created_at`
      : `id, sku, brand, model_name as name, series, scale, casing, tag, subtags,
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         (COALESCE(stock, total_stock, 0) <= 0) as "isSoldOut",
         is_prebook as "isPrebook",
         COALESCE(customer_eta, arrival_date) as "customerEta",
         image, created_at`;

    const queryStr = `
      SELECT ${selectFields}
      FROM products
      WHERE deleted_at IS NULL
      ${adminMode ? '' : "AND (status IN ('Published', 'Pre-Order', 'Active') OR status IS NULL)"}
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
    const limit = Math.max(1, Math.min(maxLimit, Number(options.limit || defaultPageSize)));
    const page = Math.max(1, Number(options.page || 1));
    const offset = options.offset !== undefined ? Number(options.offset) : (page - 1) * limit;

    const selectFields = options.adminMode
      ? `id, sku, brand, model_name as name, series, scale, casing, tag, subtags, status,
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         COALESCE(stock, total_stock, 0)::int as "availableStock",
         is_prebook as "isPrebook",
         COALESCE(customer_eta, arrival_date) as "customerEta",
         image, created_at`
      : `id, sku, brand, model_name as name, series, scale, casing, tag, subtags,
         COALESCE(selling_price, base_price, 0.00) as price,
         COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
         (COALESCE(stock, total_stock, 0) <= 0) as "isSoldOut",
         is_prebook as "isPrebook",
         COALESCE(customer_eta, arrival_date) as "customerEta",
         image, created_at`;

    let queryStr = `
      SELECT ${selectFields}
      FROM products
      WHERE deleted_at IS NULL
    `;

    if (!options.adminMode) {
      queryStr += ` AND (status IN ('Published', 'Pre-Order', 'Active') OR status IS NULL)`;
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

    if (options.search) {
      queryStr += ` AND (
        LOWER(model_name) LIKE LOWER($${paramIndex}) OR
        LOWER(brand) LIKE LOWER($${paramIndex}) OR
        LOWER(series) LIKE LOWER($${paramIndex}) OR
        LOWER(sku) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    if (options.inStock) {
      queryStr += ` AND COALESCE(stock, total_stock, 0) > 0`;
    }

    if (options.preBooking) {
      queryStr += ` AND (is_prebook = true OR status = 'Pre-Order')`;
    }

    const countQuery = `SELECT COUNT(*)::int as total FROM (${queryStr}) as sub`;
    const countRows = await this.dataSource.query(countQuery, params);
    const total = parseInt(countRows[0]?.total || '0', 10);

    queryStr += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const rows = await this.dataSource.query(queryStr, params);

    return {
      products: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async getProduct(id: string, adminMode = false) {
    const cacheKey = `product_${id}_${adminMode}`;
    const cached = localCache.get(cacheKey);
    if (cached) return cached;

    const queryStr = `
      SELECT id, sku, brand, model_name as name, series, scale, casing,
             casing as "casingType", description, tag, subtags, tags, category,
             status, show_on_homepage as "showOnHomepage",
             max_qty_per_customer as "maxQtyPerCustomer",
             COALESCE(selling_price, base_price, 0.00) as "sellingPrice",
             COALESCE(selling_price, base_price, 0.00) as price,
             COALESCE(po_amount, prebook_deposit_amount, 0.00) as "poAmount",
             COALESCE(po_amount, prebook_deposit_amount, 0.00) as "prebookDepositAmount",
             COALESCE(stock, total_stock, 0)::int as "availableStock",
             COALESCE(stock, total_stock, 0)::int as stock,
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

    localCache.set(cacheKey, product, 10);
    return product;
  }
}
