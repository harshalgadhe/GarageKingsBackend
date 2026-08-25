import { Controller, Get, Post, Patch, Delete, Param, Query, Body, Request, UseGuards, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ProductsService } from './products.service.js';
import { ApiService } from '../api/api.service.js';
import { AdminProductResponseDto } from './dto/admin-product-response.dto.js';

@Controller('api/v1/admin/products')
@UseGuards(AuthGuard('jwt'))
export class AdminProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly apiService: ApiService
  ) {}

  private checkAdmin(req: any) {
    const role = req.user?.role;
    if (role !== 'Owner' && role !== 'Admin') {
      throw new ForbiddenException('Access denied.');
    }
  }

  @Get()
  async getProducts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('brand') brand?: string,
    @Query('scale') scale?: string,
    @Query('tag') tag?: string,
    @Query('inStock') inStock?: string,
    @Query('preBooking') preBooking?: string,
    @Query('featured') featured?: string,
    @Request() req?: any
  ) {
    this.checkAdmin(req);
    const parsedPage = page !== undefined && page !== null ? Math.max(1, parseInt(String(page), 10) || 1) : 1;
    const parsedLimit = limit !== undefined && limit !== null ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 10)) : 10;
    const searchClean = typeof search === 'string' ? search.trim() : undefined;

    const result = await this.productsService.getPaginatedProducts({
      page: parsedPage,
      limit: parsedLimit,
      search: searchClean || undefined,
      brand: brand?.trim() || undefined,
      scale: scale?.trim() || undefined,
      tag: tag?.trim() || undefined,
      inStock: inStock === 'true',
      preBooking: preBooking === 'true',
      featured: featured !== undefined ? featured === 'true' : undefined,
      adminMode: true
    });

    return {
      products: result.products.map(p => AdminProductResponseDto.fromEntity(p)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages
    };
  }

  @Post()
  async addProduct(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addProduct(body, req.user.email, req.ip);
  }

  @Get('backup')
  async backupProducts(@Request() req: any) {
    this.checkAdmin(req);
    const products: any[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const result = await this.productsService.getPaginatedProducts({ page, limit: 100, adminMode: true });
      products.push(...result.products.map(product => AdminProductResponseDto.fromEntity(product)));
      totalPages = result.totalPages;
      page += 1;
    } while (page <= totalPages);
    const storedImages = await this.productsService.getBackupImageReferences(products.map(product => product.id));
    products.forEach(product => {
      const references = [
        ...(Array.isArray(product.images) ? product.images : []),
        ...(storedImages[product.id] || []),
        product.image,
      ].map(image => {
        if (typeof image === 'string') return image.trim();
        return String(image?.fullUrl || image?.url || image?.mediumUrl || image?.thumbnailUrl || '').trim();
      }).filter(Boolean);
      product.images = Array.from(new Set(references));
      if (!product.image && product.images.length > 0) product.image = product.images[0];
    });
    return { products };
  }

  @Post('bulk')
  async restoreProducts(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    const operations = Array.isArray(body?.operations) ? body.operations.slice(0, 10) : [];
    const failures: any[] = [];
    let created = 0;
    let updated = 0;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index] || {};
      try {
        if (operation.action === 'update' && operation.id) {
          await this.apiService.updateProduct(operation.id, operation.product || {}, req.user.email, req.ip);
          updated += 1;
        } else {
          await this.apiService.addProduct(operation.product || {}, req.user.email, req.ip);
          created += 1;
        }
      } catch (error: any) {
        failures.push({ index, rowNumber: operation.rowNumber, sku: operation.sku, message: error?.message || 'Product could not be saved.' });
      }
    }
    return { created, updated, failures };
  }

  @Get('sku-availability/check')
  async checkSkuAvailability(
    @Query('sku') sku: string,
    @Query('excludeId') excludeId: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.productsService.checkSkuAvailability(sku, excludeId?.trim() || undefined);
  }

  @Patch(':id')
  async updateProduct(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateProduct(id, body, req.user.email, req.ip);
  }

  @Delete(':id')
  async deleteProduct(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.softDeleteProduct(id, req.user.email, req.ip);
  }
}
