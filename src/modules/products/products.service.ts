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

    const queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale,
             p.description, p.tags, p.category, p.status, p.show_on_homepage as "showOnHomepage",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             COALESCE(MIN(pv.selling_price), 0.00) as "sellingPrice",
             COALESCE(MIN(pv.selling_price), 0.00) as "minPrice",
             COALESCE(MAX(pv.selling_price), 0.00) as "maxPrice",
             COALESCE(SUM(pv.total_stock - pv.locked_stock - pv.sold_stock), 0)::int as "availableStock",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL
      ${adminMode ? '' : "AND p.status = 'Published'"}
      GROUP BY p.id, pi.thumbnail_url
      ORDER BY p.created_at DESC;
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
  }) {
    const page = Math.max(1, Number(options.page || 1));
    const limit = Math.max(1, Math.min(100, Number(options.limit || 12)));
    const offset = (options as any).offset !== undefined ? Number((options as any).offset) : (page - 1) * limit;

    let queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.rarity_level as manufacturer, p.series, p.scale,
             p.description, p.tags, p.category, p.status, p.show_on_homepage as "showOnHomepage",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             COALESCE(MIN(pv.selling_price), 0.00) as "sellingPrice",
             COALESCE(MIN(pv.selling_price), 0.00) as "minPrice",
             COALESCE(MAX(pv.selling_price), 0.00) as "maxPrice",
             COALESCE(SUM(pv.total_stock - pv.locked_stock - pv.sold_stock), 0)::int as "availableStock",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL
    `;

    if (!options.adminMode) {
      queryStr += ` AND p.status = 'Published'`;
    }

    const params: any[] = [];
    let paramIndex = 1;

    if (options.brand) {
      queryStr += ` AND LOWER(p.brand) = LOWER($${paramIndex})`;
      params.push(options.brand);
      paramIndex++;
    }

    if (options.scale) {
      queryStr += ` AND p.scale = $${paramIndex}`;
      params.push(options.scale);
      paramIndex++;
    }

    if (options.tag) {
      queryStr += ` AND $${paramIndex} = ANY(p.tags)`;
      params.push(options.tag);
      paramIndex++;
    }

    if (options.search) {
      queryStr += ` AND (
        LOWER(p.model_name) LIKE LOWER($${paramIndex}) OR
        LOWER(p.brand) LIKE LOWER($${paramIndex}) OR
        LOWER(p.series) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    queryStr += ` GROUP BY p.id, pi.thumbnail_url`;

    let havingClause = '';
    if (options.inStock) {
      havingClause += ` HAVING COALESCE(SUM(pv.total_stock - pv.locked_stock - pv.sold_stock), 0) > 0`;
    }

    if (options.preBooking) {
      const condition = ` (p.status = 'Published' AND EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND sales_status = 'Preorder'))`;
      if (havingClause) {
        havingClause += ` AND ${condition}`;
      } else {
        havingClause += ` HAVING ${condition}`;
      }
    }

    queryStr += havingClause;

    const countQuery = `SELECT COUNT(*)::int as total FROM (${queryStr}) as sub`;
    const countRows = await this.dataSource.query(countQuery, params);
    const total = parseInt(countRows[0]?.total || '0', 10);

    queryStr += ` ORDER BY p.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
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
      SELECT id, brand, model_name as name, rarity_level as manufacturer, series, scale, description,
             tags, category, status, show_on_homepage as "showOnHomepage",
             max_qty_per_customer as "maxQtyPerCustomer", is_prebook as "isPrebook",
             prebook_deposit_amount as "prebookDepositAmount", arrival_date as "arrivalDate",
             created_at
      FROM products
      WHERE deleted_at IS NULL AND id = $1
      LIMIT 1;
    `;

    const rows = await this.dataSource.query(queryStr, [id]);
    if (rows.length === 0) return null;

    const product = rows[0];

    const variants = await this.dataSource.query(`
      SELECT pv.id, pv.sku, pv.barcode, pv.name, pv.selling_price as "sellingPrice",
             pv.customer_eta as "customerEta", pv.visibility, pv.status, pv.sales_status as "salesStatus",
             pv.dimensions, pv.weight, pv.variant_attributes as "variantAttributes",
             pv.total_stock as "totalStock", pv.sold_stock as "soldStock", pv.locked_stock as "lockedStock",
             (pv.total_stock - pv.locked_stock - pv.sold_stock) as "availableStock",
             ct.name as casing, ct.display_name as "casingDisplay"
      FROM product_variants pv
      JOIN casing_types ct ON ct.id = pv.casing_type_id
      WHERE pv.product_id = $1 AND pv.deleted_at IS NULL
    `, [id]);

    product.variants = variants;

    // Fetch images
    const images = await this.dataSource.query(`
      SELECT id, product_id as "productId", thumbnail_url as "thumbnailUrl", full_url as "fullUrl", is_primary as "isPrimary"
      FROM product_images
      WHERE product_id = $1;
    `, [id]);
    product.images = images;

    localCache.set(cacheKey, product, 10);
    return product;
  }
}
