import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
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
    // Audit execution user if authenticated
    const adminUserId = req.user?.userId || null;
    return this.receiptsService.generateBillingReceipt(dto);
  }
}
export default ReceiptsController;
