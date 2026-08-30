import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import crypto from 'crypto';
import { DynamoCatalogService } from './dynamo-catalog.service.js';

const clean = (item: any) => {
  if (!item) return item;
  const { pk, sk, entity, sourceTable, ...value } = item;
  return value;
};
const normalized = (value: any) => String(value || '').trim().toLowerCase();

@Controller('api/v1')
export class DynamoCustomerController {
  constructor(private readonly store: DynamoCatalogService) {}
  private admin(request: any) {
    if (!['Owner', 'Admin'].includes(request.user?.role)) throw new ForbiddenException('Administrative privileges required.');
  }

  @Get('health') health() { return { status: 'ok', storage: 'dynamodb', timestamp: new Date().toISOString() }; }

  @Get('profile/my')
  @UseGuards(AuthGuard('jwt'))
  async profile(@Req() request: any) {
    const item: any = (await this.store.listEntities('CUSTOMER')).find((row: any) => normalized(row.email) === normalized(request.user.email));
    return item ? clean(item) : { email: request.user.email, fullName: '', phone: '', instagram: '', address: '', city: '' };
  }

  @Post('profile/my')
  @UseGuards(AuthGuard('jwt'))
  async saveProfile(@Body() body: any, @Req() request: any) {
    const existing: any = (await this.store.listEntities('CUSTOMER')).find((row: any) => normalized(row.email) === normalized(request.user.email));
    const id = existing?.id || crypto.randomUUID();
    return clean(await this.store.saveEntity('CUSTOMER', id, {
      ...existing, ...body, email: request.user.email,
      full_name: body.fullName ?? body.full_name ?? existing?.full_name ?? '',
      updated_at: new Date().toISOString()
    }));
  }

  @Get('customers')
  @UseGuards(AuthGuard('jwt'))
  async customers(@Query('search') search: string, @Req() request: any) {
    this.admin(request);
    const term = normalized(search);
    return (await this.store.listEntities('CUSTOMER')).map(clean).filter((item: any) => !term ||
      [item.full_name, item.fullName, item.phone, item.email, item.instagram].some(value => normalized(value).includes(term)));
  }

  private async ordersWithItems() {
    const [orders, items] = await Promise.all([this.store.listEntities('ORDER'), this.store.listEntities('ORDER_ITEM')]);
    return orders.map((order: any) => ({ ...clean(order), items: items.filter((item: any) => item.order_id === order.id).map(clean) }));
  }

  @Get('orders/my')
  @UseGuards(AuthGuard('jwt'))
  async myOrders(@Req() request: any) {
    const user = await this.store.getUserByEmail(request.user.email);
    return (await this.ordersWithItems()).filter((order: any) => order.user_id === user?.id);
  }

  @Get('admin/orders')
  @UseGuards(AuthGuard('jwt'))
  async orders(@Query() query: any, @Req() request: any) {
    this.admin(request);
    const term = normalized(query.search);
    let rows = await this.ordersWithItems();
    if (query.status && query.status !== 'All') rows = rows.filter((row: any) => normalized(row.status) === normalized(query.status));
    if (term) rows = rows.filter((row: any) => JSON.stringify(row).toLowerCase().includes(term));
    rows.sort((a: any, b: any) => normalized(b.created_at).localeCompare(normalized(a.created_at)));
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 10));
    return { orders: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit, totalPages: Math.max(1, Math.ceil(rows.length / limit)) };
  }

  @Patch('admin/orders/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateOrder(@Param('id') id: string, @Body() body: any, @Req() request: any) {
    this.admin(request);
    const current = await this.store.getEntity('ORDER', id);
    if (!current) throw new NotFoundException('Order not found.');
    return clean(await this.store.saveEntity('ORDER', id, { ...current, ...body, updated_at: new Date().toISOString() }));
  }
}
