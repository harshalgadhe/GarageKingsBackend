import { Controller, Post, Get, Delete, Param, Body, UseGuards, Request, Query, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ReceiptsService, CreateReceiptDto } from './receipts.service.js';

@Controller('api/v1/receipts')
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
  @UseGuards(AuthGuard('jwt'))
  async saveBillingInvoice(
    @Body() dto: CreateReceiptDto,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.receiptsService.generateBillingReceipt(dto);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
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

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  async deleteReceipt(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.receiptsService.deleteReceipt(id);
  }
}
export default ReceiptsController;
