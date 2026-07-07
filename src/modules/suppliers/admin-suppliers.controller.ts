import { Controller, Get, Post, Patch, Param, Body, Query, Request, UseGuards, UseInterceptors, UploadedFile, Res, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response as ExpressResponse } from 'express';
import { ApiService } from '../api/api.service.js';
import { validateFileSignature } from '../api/api.helpers.js';

@Controller('api/v1/admin/suppliers')
@UseGuards(AuthGuard('jwt'))
export class AdminSuppliersController {
  constructor(private readonly apiService: ApiService) {}

  private checkAdmin(req: any) {
    const role = req.user?.role;
    if (role !== 'Owner' && role !== 'Admin') {
      throw new UnauthorizedException('Administrative privileges required.');
    }
  }

  @Get()
  async getSuppliers(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSuppliers();
  }

  @Post()
  async createSupplier(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.createSupplier(dto, req.user.email, req.ip);
  }

  @Get('purchases')
  async getSupplierPurchases(
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Query('search') search = "",
    @Request() req: any
  ) {
    this.checkAdmin(req);
    const p = page ? parseInt(page, 10) : 1;
    const l = limit ? parseInt(limit, 10) : 10;
    return this.apiService.getSupplierPurchases(p, l, search);
  }

  @Post('purchases')
  async addSupplierPurchase(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addSupplierPurchase(dto, req.user.email, req.ip);
  }

  @Get('purchases/:id')
  async getSupplierPurchaseDetails(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSupplierPurchaseDetails(id);
  }

  @Post('purchases/:id/pay')
  async recordSupplierPayment(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.recordSupplierPayment(id, dto, req.user.email, req.ip);
  }

  @Post('purchases/:id/receive')
  async receiveSupplierShipment(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.receiveSupplierShipment(id, dto, req.user.email, req.ip);
  }

  @Patch('purchases/:id/status')
  async updateSupplierPurchaseStatus(
    @Param('id') id: string,
    @Body() dto: { status: string },
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.apiService.updateSupplierPurchaseStatus(id, dto.status, req.user.email, req.ip);
  }

  @Get('metrics')
  async getSupplierMetrics(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSupplierMetrics();
  }

  @Post('purchases/:id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  async addSupplierAttachment(
    @Param('id') purchaseId: string,
    @UploadedFile() file: any,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    if (!file) {
      throw new BadRequestException('No attachment file provided.');
    }
    const signature = validateFileSignature(file.buffer);
    if (!signature.isValid) {
      throw new BadRequestException('Invalid file signature. Only JPG, PNG, WebP, and PDF files are allowed.');
    }
    const extension = signature.mime.split('/').pop() || 'pdf';
    return this.apiService.addSupplierPurchaseAttachment(purchaseId, file.buffer, file.originalname, extension, req.user.email);
  }

  @Get('attachments/:id')
  async getSupplierAttachment(
    @Param('id') attachmentId: string,
    @Request() req: any,
    @Res() res: ExpressResponse
  ) {
    this.checkAdmin(req);
    const result = await this.apiService.getSupplierAttachmentStream(attachmentId);
    if (!result) {
      throw new NotFoundException('Attachment not found.');
    }
    const mime = result.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${result.filename}"`);
    result.stream.pipe(res);
  }
}
export default AdminSuppliersController;
