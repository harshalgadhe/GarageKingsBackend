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

    const adminFields = adminMode ? `
      p.purchase_price as "purchasePrice",
      p.total_stock as "totalStock",
      p.locked_stock as "lockedStock",
      p.sold_stock as "soldStock",
      p.supplier,
      p.created_by as "createdBy",
      p.updated_by as "updatedBy",
    ` : '';

    let queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.selling_price as "sellingPrice",
             ${adminFields}
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             p.is_prebook as "isPrebook", p.prebook_deposit_amount as "prebookDepositAmount",
             p.casing_types as "casingTypes",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL
    `;

    if (!adminMode) {
      queryStr += " AND p.status = 'Published'";
    }

    queryStr += " ORDER BY p.created_at DESC;";

    const rows = await this.dataSource.query(queryStr);
    localCache.set(cacheKey, rows, 10);
    return rows;
  }

  async getPaginatedProducts(options: {
    page?: number;
    limit?: number;
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
    const offset = (page - 1) * limit;

    const adminFields = options.adminMode ? `
      p.purchase_price as "purchasePrice",
      p.total_stock as "totalStock",
      p.locked_stock as "lockedStock",
      p.sold_stock as "soldStock",
      p.supplier,
      p.created_by as "createdBy",
      p.updated_by as "updatedBy",
    ` : '';

    let queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.selling_price as "sellingPrice",
             ${adminFields}
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             p.is_prebook as "isPrebook", p.prebook_deposit_amount as "prebookDepositAmount",
             p.casing_types as "casingTypes",
             pi.thumbnail_url as image, p.created_at
      FROM products p
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

    if (options.inStock) {
      queryStr += ` AND (p.total_stock - p.locked_stock - p.sold_stock) > 0`;
    }

    if (options.preBooking) {
      queryStr += ` AND (p.is_prebook = true OR 'Pre-Order' = ANY(p.tags) OR 'Pre Booking' = ANY(p.tags) OR (p.release_date IS NOT NULL AND p.release_date > CURRENT_DATE))`;
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

    const adminFields = adminMode ? `
      p.purchase_price as "purchasePrice",
      p.total_stock as "totalStock",
      p.locked_stock as "lockedStock",
      p.sold_stock as "soldStock",
      p.supplier,
      p.created_by as "createdBy",
      p.updated_by as "updatedBy",
    ` : '';

    const queryStr = `
      SELECT p.id, p.brand, p.model_name as name, p.series, p.scale, p.sku, 
             p.rarity_level as lane, p.rarity_level as grade, p.base_price as price, p.description,
             p.tags, p.category, p.selling_price as "sellingPrice",
             ${adminFields}
             (p.total_stock - p.locked_stock - p.sold_stock) as "availableStock",
             p.arrival_date as "arrivalDate", p.release_date as "releaseDate",
             p.status, p.show_on_homepage as "showOnHomepage",
             p.max_qty_per_customer as "maxQtyPerCustomer",
             p.is_prebook as "isPrebook", p.prebook_deposit_amount as "prebookDepositAmount",
             p.casing_types as "casingTypes",
             pi.thumbnail_url as image, p.created_at
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      WHERE p.deleted_at IS NULL AND p.id = $1
      LIMIT 1;
    `;

    const rows = await this.dataSource.query(queryStr, [id]);
    if (rows.length === 0) return null;

    const product = rows[0];
    const casingRows = await this.dataSource.query(`
      SELECT DISTINCT casing_type 
      FROM inventory_batches 
      WHERE product_id = $1 AND quantity_available > 0
    `, [id]);
    const casings = casingRows.map((r: any) => r.casing_type);
    product.availableCasings = casings;

    localCache.set(cacheKey, product, 10);
    return product;
  }
}
