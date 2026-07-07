import { Controller, Get, Post, Param, UploadedFile, Request, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiService } from '../api/api.service.js';
import { validateFileSignature } from '../api/api.helpers.js';

@Controller('api/v1/customer/orders')
@UseGuards(AuthGuard('jwt'))
export class CustomerOrdersController {
  constructor(private readonly apiService: ApiService) {}

  @Get('my')
  async getMyOrders(@Request() req: any) {
    return this.apiService.getCustomerOrders(req.user.email);
  }

  @Post(':id/screenshot')
  @UseInterceptors(FileInterceptor('file'))
  async uploadScreenshot(
    @Param('id') orderId: string,
    @UploadedFile() file: any,
    @Request() req: any
  ) {
    if (!file) {
      throw new BadRequestException('No screenshot file provided.');
    }
    const signature = validateFileSignature(file.buffer);
    if (!signature.isValid) {
      throw new BadRequestException('Invalid file signature. Only JPG, PNG, and WebP images are allowed.');
    }
    const extension = signature.mime.split('/').pop() || 'webp';
    return this.apiService.saveScreenshotReceipt(orderId, file.buffer, extension, req.user.userId, req.ip);
  }

  @Post(':id/submit-remaining-payment')
  @UseInterceptors(FileInterceptor('file'))
  async submitRemainingPayment(
    @Param('id') orderId: string,
    @UploadedFile() file: any,
    @Request() req: any
  ) {
    if (!file) {
      throw new BadRequestException('No payment screenshot provided.');
    }
    const signature = validateFileSignature(file.buffer);
    if (!signature.isValid) {
      throw new BadRequestException('Invalid file signature. Only JPG, PNG, and WebP images are allowed.');
    }
    const extension = signature.mime.split('/').pop() || 'webp';
    return this.apiService.customerSubmitRemainingPayment(orderId, file.buffer, extension, req.user.userId, req.ip);
  }
}
export default CustomerOrdersController;
