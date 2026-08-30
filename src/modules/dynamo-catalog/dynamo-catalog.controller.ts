import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import crypto from 'crypto';
import { Response } from 'express';
import { validateFileSignature } from '../api/api.helpers.js';
import { DynamoCatalogService } from './dynamo-catalog.service.js';
import { DynamoAssetsService } from './dynamo-assets.service.js';
import { writeStorageDriverPreference } from '../../config/storage-driver.config.js';

function queryOptions(query: any, adminMode = false) {
  return { ...query, page: Number(query.page) || 1, limit: Number(query.limit) || undefined,
    offset: query.offset === undefined ? undefined : Number(query.offset), inStock: query.inStock === 'true',
    preBooking: query.preBooking === 'true', featured: query.featured === undefined ? undefined : query.featured === 'true', adminMode };
}

@Controller('api/v1')
export class DynamoPublicCatalogController {
  constructor(private readonly catalog: DynamoCatalogService, private readonly assets: DynamoAssetsService) {}

  @Get('products')
  getProducts(@Query() query: any) { return this.catalog.listProducts(queryOptions(query)); }

  @Get('products/homepage')
  async getHomepageProducts() {
    const result = await this.catalog.listProducts({ adminMode: false, featured: true, limit: 12 });
    if (result.products.length) return result.products;
    return (await this.catalog.listProducts({ adminMode: false, limit: 12 })).products;
  }

  @Get('products/:id')
  async getProduct(@Param('id') id: string) {
    const product = await this.catalog.getProduct(id);
    if (!product) throw new NotFoundException('Product not found.');
    return product;
  }

  @Get('brands')
  async getBrands() {
    const lookups: any = await this.catalog.getLookups();
    const all: any = await this.catalog.listProducts({ adminMode: false, limit: 100 });
    const configured: any[] = await this.catalog.listEntities('BRAND') as any[];
    return lookups.brands.map((name: string) => ({
      ...(configured.find(item => String(item.name).toLowerCase() === name.toLowerCase()) || {}),
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), isVisible: true,
      productCount: all.products.filter((product: any) => product.brand === name).length
    }));
  }

  @Get('settings')
  getSettings() { return this.catalog.getSettings(); }

  @Get('public/settings')
  getPublicSettings() { return this.catalog.getSettings(); }

  @Get('images/:filename')
  async image(@Param('filename') filename: string, @Res() response: Response) {
    const stream = await this.assets.read(filename);
    if (!stream) throw new NotFoundException('Image not found.');
    response.setHeader('Content-Type', 'image/webp');
    stream.pipe(response);
  }
}

@Controller('api/v1')
@UseGuards(AuthGuard('jwt'))
export class DynamoAdminCatalogController {
  constructor(private readonly catalog: DynamoCatalogService, private readonly assets: DynamoAssetsService) {}
  private admin(req: any) {
    if (!['Owner', 'Admin'].includes(req.user?.role)) throw new ForbiddenException('Access denied.');
  }

  @Get('admin/products')
  getProducts(@Query() query: any, @Req() req: any) { this.admin(req); return this.catalog.listProducts(queryOptions(query, true)); }

  @Get('admin/products/backup')
  async backup(@Req() req: any) {
    this.admin(req);
    const products: any[] = await this.catalog.listEntities('PRODUCT') as any[];
    return { products: products.filter(product => !product.deletedAt).map(product => {
      const { pk, sk, entity, ...value } = product;
      return value;
    }) };
  }

  @Get('admin/products/sku-availability/check')
  checkSku(@Query('sku') sku: string, @Query('excludeId') excludeId: string, @Req() req: any) {
    this.admin(req); return this.catalog.checkSku(sku, excludeId);
  }

  @Post('admin/products')
  create(@Body() body: any, @Req() req: any) { this.admin(req); return this.catalog.createProduct(body); }

  @Post('admin/products/bulk')
  async bulk(@Body() body: any, @Req() req: any) {
    this.admin(req);
    const operations = Array.isArray(body?.operations) ? body.operations.slice(0, 10) : [];
    const failures: any[] = [];
    let created = 0;
    let updated = 0;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index] || {};
      try {
        if (operation.action === 'update' && operation.id) {
          await this.catalog.updateProduct(operation.id, operation.product || {});
          updated += 1;
        } else {
          await this.catalog.createProduct(operation.product || {});
          created += 1;
        }
      } catch (error: any) {
        failures.push({ index, rowNumber: operation.rowNumber, sku: operation.sku || operation.product?.sku, message: error?.message || 'Product could not be saved.' });
      }
    }
    return { created, updated, failures };
  }

  @Post('products')
  createLegacy(@Body() body: any, @Req() req: any) { this.admin(req); return this.catalog.createProduct(body); }

  @Patch('admin/products/:id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) { this.admin(req); return this.catalog.updateProduct(id, body); }

  @Patch('products/:id')
  updateLegacy(@Param('id') id: string, @Body() body: any, @Req() req: any) { this.admin(req); return this.catalog.updateProduct(id, body); }

  @Delete('admin/products/:id')
  remove(@Param('id') id: string, @Req() req: any) { this.admin(req); return this.catalog.deleteProduct(id); }

  @Delete('products/:id')
  removeLegacy(@Param('id') id: string, @Req() req: any) { this.admin(req); return this.catalog.deleteProduct(id); }

  @Get('admin/catalog/lookups')
  lookups(@Req() req: any) { this.admin(req); return this.catalog.getLookups(); }

  @Post('settings')
  saveSettings(@Body() body: any, @Req() req: any) { this.admin(req); return this.catalog.saveSettings(body); }

  @Get('admin/settings')
  async getAdminSettings(@Req() req: any) { this.admin(req); return { ...(await this.catalog.getSettings()), activeStorageDriver: 'dynamodb' }; }

  @Post('admin/settings')
  async saveAdminSettings(@Body() body: any, @Req() req: any) {
    this.admin(req);
    if (body?.storageDriver !== undefined) await writeStorageDriverPreference(body.storageDriver);
    return { ...(await this.catalog.saveSettings(body)), activeStorageDriver: 'dynamodb', storageRestartRequired: body?.storageDriver !== undefined };
  }

  @Post('images/upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: any, @Req() req: any) {
    this.admin(req);
    if (!file) throw new BadRequestException('No image was provided.');
    const signature = validateFileSignature(file.buffer);
    if (!signature.isValid) throw new BadRequestException('The uploaded file is not a supported image.');
    const extension = signature.mime.split('/').pop() || 'webp';
    const url = await this.assets.upload(file.buffer, `${crypto.randomUUID()}.${extension}`, signature.mime);
    return { success: true, url };
  }
}
