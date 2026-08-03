import { Controller, Get, Param, Query, NotFoundException, Headers, Req, Res } from '@nestjs/common';
import { ProductsService } from './products.service.js';
import { PublicProductResponseDto } from './dto/public-product-response.dto.js';
import { Response as ExpressResponse, Request as ExpressRequest } from 'express';
import crypto from 'crypto';

@Controller('api/v1/public/products')
export class PublicProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async getProducts(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
    @Headers('user-agent') userAgent?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('brand') brand?: string,
    @Query('scale') scale?: string,
    @Query('tag') tag?: string,
    @Query('search') search?: string,
    @Query('inStock') inStock?: string,
    @Query('preBooking') preBooking?: string
  ) {
    const result = await this.productsService.getPaginatedProducts({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      brand,
      scale,
      tag,
      search,
      inStock: inStock === 'true',
      preBooking: preBooking === 'true',
      adminMode: false,
      userAgent
    });

    const payload = {
      products: result.products.map(p => PublicProductResponseDto.fromEntity(p)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages
    };

    const jsonStr = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(jsonStr).digest('hex');
    const etag = `W/"${hash}"`;

    res.setHeader('Cache-Control', 'public, max-age=10');
    res.setHeader('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
      res.status(304);
      return;
    }

    return payload;
  }

  @Get(':id')
  async getProduct(@Param('id') id: string) {
    const product = await this.productsService.getProduct(id, false);
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return PublicProductResponseDto.fromEntity(product);
  }
}
