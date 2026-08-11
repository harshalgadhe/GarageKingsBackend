import { Controller, Get, Post, Patch, Param, Body, Query, Request, UseGuards, UseInterceptors, UploadedFile, Res, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response as ExpressResponse } from 'express';
import { ApiService } from '../api/api.service.js';
import { validateFileSignature } from '../api/api.helpers.js';

@Controller('api/v1/admin/orders')
@UseGuards(AuthGuard('jwt'))
export class AdminOrdersController {
  constructor(private readonly apiService: ApiService) {}

  private checkAdmin(req: any, allowedRoles: string[] = ['Owner', 'Admin']) {
    const role = req.user?.role;
    if (!allowedRoles.includes(role)) {
      throw new ForbiddenException('Access denied.');
    }
  }

  @Get()
  async getAdminOrders(
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Query('search') search: string,
    @Query('status') status: string,
    @Request() req: any
  ) {
    this.checkAdmin(req, ['Owner', 'Admin', 'Warehouse']);
    const pNum = page ? parseInt(page, 10) : undefined;
    const lNum = limit ? parseInt(limit, 10) : undefined;
    if (pNum || lNum || search || status) {
      return this.apiService.getPaginatedAdminOrders({ page: pNum, limit: lNum, search, status });
    }
    return this.apiService.getAdminOrders();
  }

  @Patch(':id')
  async updateOrderStatus(
    @Param('id') id: string,
    @Body() dto: { 
      status?: string; 
      courierPartner?: string; 
      trackingNumber?: string; 
      shippingCost?: number; 
      packagingCost?: number; 
      dispatchDate?: string; 
      deliveryDate?: string;
      totalPrice?: number;
      advanceAmount?: number;
      remainingAmount?: number;
      shippingAddress?: string;
    },
    @Request() req: any
  ) {
    this.checkAdmin(req, ['Owner', 'Admin', 'Warehouse']);
    const role = req.user?.role;
    if (dto.status === 'Confirmed') {
      return this.apiService.adminConfirmOrder(id, req.user.email, req.ip, role);
    }
    return this.apiService.adminUpdateOrderStatus(id, dto, req.user.email, req.ip, role);
  }

  @Post(':id/collect-remaining')
  @UseInterceptors(FileInterceptor('file'))
  async collectRemainingPayment(
    @Param('id') orderId: string,
    @UploadedFile() file: any,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    if (!file) {
      throw new BadRequestException('No payment screenshot provided.');
    }
    const signature = validateFileSignature(file.buffer);
    if (!signature.isValid) {
      throw new BadRequestException('Invalid file signature. Only JPG, PNG, and WebP images are allowed.');
    }
    const extension = signature.mime.split('/').pop() || 'webp';
    return this.apiService.collectRemainingPayment(orderId, file.buffer, extension, req.user.email, req.ip);
  }

  @Get(':id/receipt')
  async getOrderReceipt(@Param('id') orderId: string, @Request() req: any) {
    this.checkAdmin(req, ['Owner', 'Admin', 'Warehouse']);
    return this.apiService.generateReceiptForOrder(orderId);
  }

  @Get(':id/screenshot')
  async getScreenshot(@Param('id') orderId: string, @Request() req: any, @Res() res: ExpressResponse) {
    this.checkAdmin(req);
    const result = await this.apiService.getPrivateScreenshotStream(orderId);
    if (!result) {
      throw new NotFoundException('Screenshot not found for this order.');
    }
    res.setHeader('Content-Type', 'image/jpeg');
    result.stream.pipe(res);
  }
}
export default AdminOrdersController;
