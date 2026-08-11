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
