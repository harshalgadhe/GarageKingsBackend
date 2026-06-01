import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiService } from './api.service.js';

@Controller('api/v1')
export class ApiController {
  constructor(private readonly apiService: ApiService) {}

  @Post('auth/auto-confirm')
  async autoConfirmUser(@Body() dto: { email: string }) {
    const { email } = dto;
    if (!email) {
      throw new Error('Email is required for auto-confirmation');
    }

    try {
      const userPoolId = process.env.COGNITO_USER_POOL_ID || 'ap-south-1_YaTasZ9v0';
      const region = process.env.COGNITO_AWS_REGION || 'ap-south-1';
      const cleanEmail = email.trim();
      
      const { execSync } = await import('child_process');
      
      console.log(`[AutoConfirm] Admin confirming signup for user: ${cleanEmail}`);
      execSync(
        `aws cognito-idp admin-confirm-sign-up --user-pool-id ${userPoolId} --username "${cleanEmail}" --region ${region}`
      );
      
      console.log(`[AutoConfirm] Admin updating email_verified: true for user: ${cleanEmail}`);
      execSync(
        `aws cognito-idp admin-update-user-attributes --user-pool-id ${userPoolId} --username "${cleanEmail}" --user-attributes Name=email_verified,Value=true --region ${region}`
      );

      return { success: true, message: 'Collector account auto-confirmed successfully!' };
    } catch (error: any) {
      console.error(`[AutoConfirm] Failed to confirm user ${email}:`, error);
      throw new UnauthorizedException(`Auto-confirmation failed: ${error.message}`);
    }
  }

  // Helper validation ensuring the caller belongs to the Cognito 'admin' group
  private checkAdmin(req: any) {
    const roles = req.user?.roles || [];
    if (!roles.includes('admin')) {
      throw new UnauthorizedException('Administrative privileges required to modify vault metadata.');
    }
  }

  // ── PRODUCTS REST ENDPOINTS ─────────────────────────────────────────
  @Get('products')
  async getProducts() {
    return this.apiService.getProducts();
  }

  @Post('products')
  @UseGuards(AuthGuard('jwt'))
  async addProduct(@Body() car: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addProduct(car);
  }

  @Patch('products/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateProduct(@Param('id') id: string, @Body() car: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateProduct(id, car);
  }

  @Delete('products/:id')
  @UseGuards(AuthGuard('jwt'))
  async deleteProduct(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.deleteProduct(id);
  }

  @Post('products/reorder')
  @UseGuards(AuthGuard('jwt'))
  async reorderProducts(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return { success: true };
  }

  // ── SETTINGS REST ENDPOINTS ─────────────────────────────────────────
  @Get('settings')
  async getSettings() {
    return this.apiService.getSettings();
  }

  @Post('settings')
  @UseGuards(AuthGuard('jwt'))
  async updateSettings(@Body() settings: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateSettings(settings);
  }

  // ── AUCTIONS REST ENDPOINTS ─────────────────────────────────────────
  @Get('auctions')
  async getAuctions() {
    return this.apiService.getAuctions();
  }

  @Post('auctions')
  @UseGuards(AuthGuard('jwt'))
  async addAuction(@Body() auction: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addAuction(auction);
  }

  @Patch('auctions/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateAuction(@Param('id') id: string, @Body() auction: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateAuction(id, auction);
  }

  @Delete('auctions/:id')
  @UseGuards(AuthGuard('jwt'))
  async deleteAuction(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.deleteAuction(id);
  }

  // ── AUCTION BIDS REST ENDPOINTS ──────────────────────────────────────
  @Get('auctions/:id/bids')
  async getAuctionBids(@Param('id') id: string) {
    return this.apiService.getAuctionBids(id);
  }

  @Post('auctions/:id/bids')
  @UseGuards(AuthGuard('jwt'))
  async addAuctionBid(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    const cognitoSub = req.user?.userId;
    const email = req.user?.email || 'anonymous@collector.com';
    const userId = await this.apiService.getOrCreateUser(cognitoSub, email);
    return this.apiService.addAuctionBid(id, userId, Number(dto.amount));
  }

  // ── CRM CUSTOMERS REST ENDPOINTS ─────────────────────────────────────
  @Get('customers')
  @UseGuards(AuthGuard('jwt'))
  async getCustomers(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getCustomers();
  }

  @Post('customers')
  @UseGuards(AuthGuard('jwt'))
  async addCustomer(@Body() customer: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addCustomer(customer);
  }

  // ── CUSTOMERS E-COMMERCE ORDERS ────────────────────────────────────
  @Post('orders')
  @UseGuards(AuthGuard('jwt'))
  async placeOrder(@Body() dto: any, @Request() req: any) {
    const cognitoSub = req.user?.userId;
    const email = req.user?.email;
    if (!email) {
      throw new UnauthorizedException('Acquisition placement requires verified Cognito email address.');
    }
    const userId = await this.apiService.getOrCreateUser(cognitoSub, email);
    return this.apiService.placeOrder(userId, dto);
  }

  @Get('orders')
  @UseGuards(AuthGuard('jwt'))
  async getCustomerOrders(@Request() req: any) {
    const email = req.user?.email;
    if (!email) {
      throw new UnauthorizedException('Collector profile queries require active authenticated session.');
    }
    return this.apiService.getCustomerOrders(email);
  }
}
export default ApiController;
