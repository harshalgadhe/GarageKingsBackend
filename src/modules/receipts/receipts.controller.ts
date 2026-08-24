import { Controller, Post, Get, Delete, Patch, Param, Body, Request, Query, UseGuards, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ReceiptsService } from './receipts.service.js';
import { CreateReceiptDto, VoidReceiptDto } from './receipts.dto.js';

@Controller(['api/v1/receipts', 'api/v1/admin/receipts'])
@UseGuards(AuthGuard('jwt'))
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  private checkAdmin(req: any) {
    const role = req.user?.role;
    if (role !== 'Owner' && role !== 'Admin') {
      throw new ForbiddenException('Administrative privileges required.');
    }
  }

  /**
   * Save billing receipts and line items
   */
  @Post()
  async saveBillingInvoice(
    @Body() dto: CreateReceiptDto,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.receiptsService.generateBillingReceipt(dto);
  }

  @Get()
  async getReceipts(
    @Query('page') page: number,
    @Query('limit') limit: number,
    @Query('search') search: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    if (page || limit || search) {
      return this.receiptsService.getPaginatedReceipts({ page, limit, search });
    }
    return this.receiptsService.getReceipts();
  }

  @Get('backup/all')
  async backupReceipts(@Query('search') search: string, @Request() req: any) {
    this.checkAdmin(req);
    const query = String(search || '').trim().toLowerCase();
    const receipts = await this.receiptsService.getReceipts();
    return { receipts: query ? receipts.filter((receipt: any) => JSON.stringify(receipt).toLowerCase().includes(query)) : receipts };
  }

  @Post('bulk')
  async restoreReceipts(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    const receipts = Array.isArray(body?.receipts) ? body.receipts.slice(0, 50) : [];
    const updateExisting = body?.updateExisting === true;
    if (!receipts.length) return { created: 0, updated: 0, skipped: [], failures: [] };
    const existing = await this.receiptsService.getReceipts();
    const existingByNumber = new Map<string, any>(existing
      .map((receipt: any): [string, any] => [String(receipt.receiptNumber || receipt.receipt_number || '').trim().toLowerCase(), receipt])
      .filter(([number]) => Boolean(number)));
    const skipped: any[] = [];
    const failures: any[] = [];
    let created = 0;
    let updated = 0;
    for (let index = 0; index < receipts.length; index += 1) {
      const source = receipts[index] || {};
      const receiptNumber = String(source.receiptNumber || '').trim();
      if (!receiptNumber) { failures.push({ index, receiptNumber, message: 'Receipt Number is required.' }); continue; }
      const current = existingByNumber.get(receiptNumber.toLowerCase());
      if (current && !updateExisting) { skipped.push({ index, receiptNumber, reason: 'Receipt Number already exists.' }); continue; }
      const receipt = { ...source, customerPhone: String(source.customerPhone || '').trim() || 'Not provided' };
      try {
        if (current) {
          await this.receiptsService.updateReceipt(current.id, receipt, req.user.email);
          updated += 1;
        } else {
          const saved: any = await this.receiptsService.generateBillingReceipt(receipt);
          existingByNumber.set(receiptNumber.toLowerCase(), saved);
          created += 1;
        }
      } catch (error: any) {
        failures.push({ index, receiptNumber, message: error?.message || 'Receipt could not be saved.' });
      }
    }
    return { created, updated, skipped, failures };
  }

  @Get(':id')
  async getReceiptById(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.receiptsService.getReceiptById(id);
  }

  @Patch(':id')
  async updateReceipt(
    @Param('id') id: string,
    @Body() dto: CreateReceiptDto,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.receiptsService.updateReceipt(id, dto, req.user.email);
  }

  @Patch(':id/void')
  async voidReceipt(@Param('id') id: string, @Body() dto: VoidReceiptDto, @Request() req: any) {
    this.checkAdmin(req);
    return this.receiptsService.voidReceipt(id, dto, req.user.email);
  }

  @Delete(':id')
  async deleteReceipt(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.receiptsService.deleteReceipt(id, req.user.email);
  }
}
export default ReceiptsController;
