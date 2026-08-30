import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import crypto from 'crypto';
import { DynamoCatalogService } from './dynamo-catalog.service.js';

const clean = (item: any) => {
  if (!item) return item;
  const { pk, sk, entity, sourceTable, ...value } = item;
  return value;
};

@Controller('api/v1')
export class DynamoPublicMasterDataController {
  constructor(private readonly store: DynamoCatalogService) {}
  @Get('manufacturers') async manufacturers() { return (await this.store.listEntities('MANUFACTURER')).map(clean); }
  @Get('scales') async scales() { return (await this.store.listEntities('SCALE')).map(clean); }
  @Get('series') async series() { return (await this.store.listEntities('SERIES')).map(clean); }
  @Get('categories') async categories() { return (await this.store.listEntities('CATEGORY')).map(clean); }
  @Get('tags') async tags() { return (await this.store.listEntities('TAG')).map(clean); }
  @Get('payment-methods') async paymentMethods() { return (await this.store.listEntities('PAYMENT_METHOD')).map(clean); }
  @Get('shipping-providers') async shippingProviders() { return (await this.store.listEntities('SHIPPING_PROVIDER')).map(clean); }
  @Get('order-statuses') orderStatuses() { return ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled']; }
  @Get('purchase-statuses') purchaseStatuses() { return ['Draft', 'Booked', 'Partially Received', 'Completed', 'Cancelled']; }
  @Get('logistics-statuses') logisticsStatuses() { return ['Pending', 'In Transit', 'Delivered']; }
  @Get('currencies') currencies() { return ['INR']; }
  @Get('countries') countries() { return ['India']; }
}

@Controller('api/v1/admin')
@UseGuards(AuthGuard('jwt'))
export class DynamoAdminMasterDataController {
  constructor(private readonly store: DynamoCatalogService) {}
  private admin(request: any) { if (!['Owner', 'Admin'].includes(request.user?.role)) throw new ForbiddenException('Administrative privileges required.'); }
  private async list(entity: string, request: any) { this.admin(request); return (await this.store.listEntities(entity)).map(clean); }
  private async create(entity: string, body: any, request: any) {
    this.admin(request);
    const requestedId = String(body?.id || '').trim();
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)
      ? requestedId
      : crypto.randomUUID();
    const { id: _recordId, ...value } = body || {};
    return clean(await this.store.saveEntity(entity, id, { ...value, status: value.status || 'Active', created_at: new Date().toISOString() }));
  }
  private async update(entity: string, id: string, body: any, request: any) { this.admin(request); const current = await this.store.getEntity(entity, id); return clean(await this.store.saveEntity(entity, id, { ...current, ...body, updated_at: new Date().toISOString() })); }
  private remove(entity: string, id: string, request: any) { this.admin(request); return this.store.deleteEntity(entity, id); }

  @Get('catalog/master-data/backup')
  async backup(@Req() request: any) {
    this.admin(request);
    const [brands, scales, series] = await Promise.all(['BRAND', 'SCALE', 'SERIES'].map(entity => this.store.listEntities(entity)));
    return { brands: brands.map(clean), scales: scales.map(clean), series: series.map(clean) };
  }

  @Post('catalog/master-data/bulk')
  async bulk(@Body() body: any, @Req() request: any) {
    this.admin(request);
    const typeMap: Record<string, string> = { brands: 'BRAND', scales: 'SCALE', series: 'SERIES' };
    const operations = Array.isArray(body?.operations) ? body.operations.slice(0, 50) : [];
    const failures: any[] = [];
    let created = 0;
    let updated = 0;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index] || {};
      const entity = typeMap[operation.type];
      if (!entity) { failures.push({ index, message: `Unsupported lookup type: ${operation.type || 'missing'}` }); continue; }
      try {
        const id = operation.action === 'update' && operation.id ? operation.id : crypto.randomUUID();
        const current = operation.action === 'update' ? await this.store.getEntity(entity, id) : null;
        await this.store.saveEntity(entity, id, { ...(current || {}), ...(operation.data || {}), updated_at: new Date().toISOString() });
        if (operation.action === 'update') updated += 1; else created += 1;
      } catch (error: any) {
        failures.push({ index, rowNumber: operation.rowNumber, name: operation.data?.name, message: error?.message || 'Lookup record could not be saved.' });
      }
    }
    return { created, updated, failures };
  }

  @Get('brands') brands(@Req() r: any) { return this.list('BRAND', r); }
  @Post('brands') addBrand(@Body() b: any, @Req() r: any) { return this.create('BRAND', b, r); }
  @Patch('brands/:id') editBrand(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.update('BRAND', id, b, r); }
  @Delete('brands/:id') deleteBrand(@Param('id') id: string, @Req() r: any) { return this.remove('BRAND', id, r); }

  @Get('manufacturers') manufacturers(@Req() r: any) { return this.list('MANUFACTURER', r); }
  @Post('manufacturers') addManufacturer(@Body() b: any, @Req() r: any) { return this.create('MANUFACTURER', b, r); }
  @Patch('manufacturers/:id') editManufacturer(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.update('MANUFACTURER', id, b, r); }
  @Delete('manufacturers/:id') deleteManufacturer(@Param('id') id: string, @Req() r: any) { return this.remove('MANUFACTURER', id, r); }

  @Get('scales') scales(@Req() r: any) { return this.list('SCALE', r); }
  @Post('scales') addScale(@Body() b: any, @Req() r: any) { return this.create('SCALE', b, r); }
  @Patch('scales/:id') editScale(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.update('SCALE', id, b, r); }
  @Delete('scales/:id') deleteScale(@Param('id') id: string, @Req() r: any) { return this.remove('SCALE', id, r); }

  @Get('series') series(@Req() r: any) { return this.list('SERIES', r); }
  @Post('series') addSeries(@Body() b: any, @Req() r: any) { return this.create('SERIES', b, r); }
  @Patch('series/:id') editSeries(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.update('SERIES', id, b, r); }
  @Delete('series/:id') deleteSeries(@Param('id') id: string, @Req() r: any) { return this.remove('SERIES', id, r); }

  @Get('categories') categories(@Req() r: any) { return this.list('CATEGORY', r); }
  @Post('categories') addCategory(@Body() b: any, @Req() r: any) { return this.create('CATEGORY', b, r); }
  @Patch('categories/:id') editCategory(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.update('CATEGORY', id, b, r); }
  @Delete('categories/:id') deleteCategory(@Param('id') id: string, @Req() r: any) { return this.remove('CATEGORY', id, r); }

  @Get('tags') tags(@Req() r: any) { return this.list('TAG', r); }
  @Post('tags') addTag(@Body() b: any, @Req() r: any) { return this.create('TAG', b, r); }
  @Patch('tags/:id') editTag(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.update('TAG', id, b, r); }
  @Delete('tags/:id') deleteTag(@Param('id') id: string, @Req() r: any) { return this.remove('TAG', id, r); }
}
