import { Controller, Post, Get, Delete, Param, Body, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ReceiptsService, CreateReceiptDto } from './receipts.service.js';

@Controller('api/v1/receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  /**
   * Save billing receipts and line items
   * Guarded by AWS Cognito JWT tokens authorizer validation guards
   */
  @Post()
  @UseGuards(AuthGuard('jwt'))
  async saveBillingInvoice(
    @Body() dto: CreateReceiptDto,
    @Request() req: any
  ) {
    return this.receiptsService.generateBillingReceipt(dto);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  async getReceipts(@Request() req: any) {
    return this.receiptsService.getReceipts();
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  async deleteReceipt(@Param('id') id: string, @Request() req: any) {
    return this.receiptsService.deleteReceipt(id);
  }
}
export default ReceiptsController;
