import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import crypto from 'crypto';
import { DynamoCatalogService } from './dynamo-catalog.service.js';

const clean = (item: any) => {
  if (!item) return item;
  const { pk, sk, entity, sourceTable, ...value } = item;
  return value;
};
const page = (values: any[], query: any) => {
  const current = Math.max(1, Number(query.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 10));
  return { values: values.slice((current - 1) * limit, current * limit), total: values.length,
    page: current, limit, totalPages: Math.max(1, Math.ceil(values.length / limit)) };
};
const receiptTimestamp = (receipt: any) => {
  const candidates = [receipt?.receiptDate, receipt?.receipt_date, receipt?.dateString, receipt?.createdAt, receipt?.created_at];
  for (const value of candidates) {
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
};
const sortReceiptsNewestFirst = (values: any[]) => values.sort((left, right) =>
  receiptTimestamp(right) - receiptTimestamp(left)
  || String(right?.receiptNumber || '').localeCompare(String(left?.receiptNumber || ''), undefined, { numeric: true })
);

@Controller('api/v1')
@UseGuards(AuthGuard('jwt'))
export class DynamoAdminDataController {
  constructor(private readonly store: DynamoCatalogService) {}
  private admin(request: any) {
    if (!['Owner', 'Admin'].includes(request.user?.role)) throw new ForbiddenException('Administrative privileges required.');
  }

  @Get('admin/customers')
  async customers(@Query() query: any, @Req() request: any) {
    this.admin(request);
    const search = String(query.search || '').trim().toLowerCase();
    const [userItems, profiles, orders] = await Promise.all([
      this.store.listEntities('USER'),
      this.store.listEntities('CUSTOMER'),
      this.store.listEntities('ORDER')
    ]);
    const profilesByEmail = new Map(profiles.map((item: any) => [String(item.email || '').trim().toLowerCase(), clean(item)]));
    const allCustomers = userItems.map((item: any) => {
      const user: any = clean(item);
      const profile: any = profilesByEmail.get(String(user.email || '').trim().toLowerCase()) || {};
      const customerOrders = orders.filter((order: any) => String(order.user_id || order.userId || '') === String(user.id));
      const totalSpend = customerOrders
        .filter((order: any) => ['Confirmed', 'Shipped', 'Delivered'].includes(String(order.status || '')))
        .reduce((sum: number, order: any) => sum + Number(order.total_price || order.totalPrice || 0), 0);
      const createdAt = user.createdAt || user.created_at || null;
      const lastOrderDate = customerOrders.map((order: any) => order.createdAt || order.created_at).filter(Boolean).sort().at(-1) || null;
      return {
        id: user.id,
        email: user.email,
        role: user.role || 'Collector',
        createdAt,
        updatedAt: user.updatedAt || user.updated_at || null,
        name: profile.full_name || profile.fullName || profile.name || String(user.email || '').split('@')[0],
        phone: profile.phone || null,
        city: profile.city || null,
        instagramUsername: profile.instagram_username || profile.instagramUsername || profile.instagram || null,
        totalOrders: customerOrders.length,
        totalSpend,
        lastOrderDate
      };
    }).sort((left: any, right: any) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
    const customers = allCustomers.filter((customer: any) => !search || JSON.stringify(customer).toLowerCase().includes(search));
    const result = page(customers, query);
    const now = Date.now();
    const joinedSince = (days: number) => allCustomers.filter((customer: any) => {
      const timestamp = new Date(customer.createdAt || 0).getTime();
      return Number.isFinite(timestamp) && timestamp >= now - days * 86400000;
    }).length;
    return {
      customers: result.values,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      summary: {
        totalCustomers: userItems.length,
        collectors: userItems.filter((item: any) => (item.role || 'Collector') === 'Collector').length,
        administrators: userItems.filter((item: any) => ['Admin', 'Owner'].includes(item.role)).length,
        joinedLast7Days: joinedSince(7),
        joinedLast30Days: joinedSince(30),
        recentCustomers: allCustomers.slice(0, 6)
      }
    };
  }

  @Get(['receipts', 'admin/receipts'])
  async receipts(@Query() query: any, @Req() request: any) {
    this.admin(request);
    const search = String(query.search || '').trim().toLowerCase();
    const values = sortReceiptsNewestFirst((await this.store.listEntities('RECEIPT')).map(clean)
      .filter(value => !search || JSON.stringify(value).toLowerCase().includes(search)));
    if (!query.page && !query.limit && !query.search) return values;
    const result = page(values, query);
    return { receipts: result.values, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages };
  }

  @Get(['receipts/backup/all', 'admin/receipts/backup/all'])
  async receiptBackup(@Query('search') searchValue: string, @Req() request: any) {
    this.admin(request);
    const search = String(searchValue || '').trim().toLowerCase();
    const receipts = sortReceiptsNewestFirst((await this.store.listEntities('RECEIPT')).map(clean)
      .filter(value => !search || JSON.stringify(value).toLowerCase().includes(search)));
    return { receipts };
  }

  @Post(['receipts', 'admin/receipts'])
  async createReceipt(@Body() body: any, @Req() request: any) {
    this.admin(request); const id = crypto.randomUUID();
    const customerPhone = String(body?.customerPhone || body?.customer_phone || '').trim() || 'Not provided';
    return clean(await this.store.saveEntity('RECEIPT', id, { ...body, customerPhone, created_at: new Date().toISOString(), created_by: request.user.email }));
  }

  @Post(['receipts/bulk', 'admin/receipts/bulk'])
  async createReceiptsBulk(@Body() body: any, @Req() request: any) {
    this.admin(request);
    const receipts = Array.isArray(body?.receipts) ? body.receipts.slice(0, 50) : [];
    const updateExisting = body?.updateExisting === true;
    if (!receipts.length) return { created: 0, updated: 0, skipped: [], failures: [] };
    const existing = await this.store.listEntities('RECEIPT');
    const existingByNumber = new Map<string, any>(existing
      .map((item: any): [string, any] => [String(item.receiptNumber || '').trim().toLowerCase(), item])
      .filter(([key]) => Boolean(key)));
    const skipped: any[] = [];
    const failures: any[] = [];
    let created = 0;
    let updated = 0;
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index] || {};
      const receiptNumber = String(receipt.receiptNumber || '').trim();
      if (!receiptNumber) { failures.push({ index, receiptNumber: '', message: 'Receipt Number is required.' }); continue; }
      const key = receiptNumber.toLowerCase();
      const current: any = existingByNumber.get(key);
      if (current && !updateExisting) { skipped.push({ index, receiptNumber, reason: 'Receipt Number already exists.' }); continue; }
      try {
        const id = current?.id || crypto.randomUUID();
        const normalizedReceipt = { ...receipt, customerPhone: String(receipt.customerPhone || receipt.customer_phone || '').trim() || 'Not provided' };
        if (current) {
          await this.store.saveEntity('RECEIPT', id, { ...current, ...normalizedReceipt, id, created_at: current.created_at, created_by: current.created_by, updated_at: new Date().toISOString(), updated_by: request.user.email });
          updated += 1;
        } else {
          const saved = await this.store.saveEntity('RECEIPT', id, { ...normalizedReceipt, id, created_at: new Date().toISOString(), created_by: request.user.email });
          existingByNumber.set(key, saved);
          created += 1;
        }
      } catch (error: any) {
        failures.push({ index, receiptNumber, message: error?.message || 'Receipt could not be saved.' });
      }
    }
    return { created, updated, skipped, failures };
  }

  @Get(['receipts/:id', 'admin/receipts/:id'])
  async receipt(@Param('id') id: string, @Req() request: any) { this.admin(request); return clean(await this.store.getEntity('RECEIPT', id)); }

  @Patch(['receipts/:id', 'admin/receipts/:id'])
  async updateReceipt(@Param('id') id: string, @Body() body: any, @Req() request: any) {
    this.admin(request); const current = await this.store.getEntity('RECEIPT', id);
    if (!current) throw new NotFoundException('Receipt not found.');
    return clean(await this.store.saveEntity('RECEIPT', id, { ...current, ...body, updated_at: new Date().toISOString() }));
  }

  @Delete(['receipts/:id', 'admin/receipts/:id'])
  removeReceipt(@Param('id') id: string, @Req() request: any) { this.admin(request); return this.store.deleteEntity('RECEIPT', id); }

  @Get('admin/dashboard/aggregates')
  async aggregates(@Req() request: any) {
    this.admin(request);
    const [products, orders, customers] = await Promise.all(['PRODUCT', 'ORDER', 'CUSTOMER'].map(entity => this.store.listEntities(entity)));
    return { products: products.length, orders: orders.length, customers: customers.length,
      revenue: orders.reduce((sum: number, order: any) => sum + Number(order.total_price || 0), 0) };
  }

  @Get('admin/performance-metrics')
  async metrics(@Req() request: any) { this.admin(request); return (await this.store.listEntities('PERFORMANCE_METRIC')).map(clean); }

  @Get('admin/telemetry/errors')
  telemetry(@Req() request: any) { this.admin(request); return { errors: [], total: 0, page: 1, totalPages: 1 }; }

  @Get('admin/telemetry/summary')
  telemetrySummary(@Req() request: any) { this.admin(request); return { unresolved: 0, acknowledged: 0, total: 0 }; }
}

@Controller('api/v1')
export class DynamoTelemetryController {
  @Post('telemetry/log') log() { return { accepted: true }; }
}
