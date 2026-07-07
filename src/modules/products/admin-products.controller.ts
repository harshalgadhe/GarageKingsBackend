import { Controller, Get, Post, Patch, Delete, Param, Query, Body, Request, UseGuards, UnauthorizedException } from '@nestjs/common';
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
      throw new UnauthorizedException('Administrative privileges required.');
    }
  }

  @Get()
  async getProducts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Request() req?: any
  ) {
    this.checkAdmin(req);
    const result = await this.productsService.getPaginatedProducts({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
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
