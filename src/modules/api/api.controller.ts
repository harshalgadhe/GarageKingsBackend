import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiService } from './api.service.js';
import { CognitoIdentityProviderClient, AdminConfirmSignUpCommand, AdminUpdateUserAttributesCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import crypto from 'crypto';

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_AWS_REGION || 'ap-south-1'
});

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
      const cleanEmail = email.trim();
      
      console.log(`[AutoConfirm] Admin confirming signup for user: ${cleanEmail}`);
      await cognitoClient.send(new AdminConfirmSignUpCommand({
        UserPoolId: userPoolId,
        Username: cleanEmail
      }));
      
      console.log(`[AutoConfirm] Admin updating email_verified: true for user: ${cleanEmail}`);
      await cognitoClient.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: cleanEmail,
        UserAttributes: [
          { Name: 'email_verified', Value: 'true' }
        ]
      }));

      return { success: true, message: 'Collector account auto-confirmed successfully!' };
    } catch (error: any) {
      console.error(`[AutoConfirm] Failed to confirm user ${email}:`, error);
      throw new UnauthorizedException(`Auto-confirmation failed: ${error.message}`);
    }
  }

  @Post('auth/google-login')
  async googleLogin(@Body() dto: { idToken: string }) {
    const { idToken } = dto;
    if (!idToken) {
      throw new UnauthorizedException('Google OAuth identity token is required.');
    }

    try {
      // 1. Verify Google ID Token via tokeninfo endpoint
      const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
      if (!googleRes.ok) {
        throw new UnauthorizedException('Google OAuth ID Token signature verification failed.');
      }
      
      const payload: any = await googleRes.json();
      
      // Verify audience matches our Google Client ID
      const expectedClientId = '984738691172-khs7a7lp6ccgk56e089b4gbfs8k48bsa.apps.googleusercontent.com';
      if (payload.aud !== expectedClientId) {
        throw new UnauthorizedException('Google OAuth client identification mismatch.');
      }
      
      if (payload.email_verified !== 'true' && payload.email_verified !== true) {
        throw new UnauthorizedException('Google email address must be verified.');
      }
      
      const cleanEmail = payload.email.trim();
      
      // 2. Generate a secure, user-specific Cognito password
      const jwtSecret = process.env.JWT_SECRET || 'gk_development_secure_fallback_jwt_signing_key_2026';
      const securePassword = crypto.createHmac('sha256', jwtSecret)
        .update(cleanEmail)
        .digest('hex') + 'aA1!'; // Append characters to guarantee Cognito password strength policies

      const userPoolId = process.env.COGNITO_USER_POOL_ID || 'ap-south-1_YaTasZ9v0';

      // 3. Create user in Cognito if they do not exist
      try {
        console.log(`[GoogleLogin] Admin creating user if new: ${cleanEmail}`);
        await cognitoClient.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: cleanEmail,
          UserAttributes: [
            { Name: 'email', Value: cleanEmail },
            { Name: 'email_verified', Value: 'true' }
          ],
          MessageAction: 'SUPPRESS'
        }));
        console.log(`[GoogleLogin] Admin successfully created user: ${cleanEmail}`);
      } catch (createError: any) {
        console.log(`[GoogleLogin] User already exists in Cognito or creation skipped: ${createError.message}`);
      }

      // 4. Update/Sync the password securely
      console.log(`[GoogleLogin] Syncing password for user: ${cleanEmail}`);
      await cognitoClient.send(new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: cleanEmail,
        Password: securePassword,
        Permanent: true
      }));

      console.log(`[GoogleLogin] Federated Google account sync completed successfully for ${cleanEmail}`);
      return { 
        success: true, 
        message: 'Google federated login synced successfully',
        email: cleanEmail,
        temporaryPassword: securePassword
      };
    } catch (error: any) {
      console.error(`[GoogleLogin] Failed to sync Google login:`, error);
      throw new UnauthorizedException(`Google login sync failed: ${error.message}`);
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

  @Get('admin/orders')
  @UseGuards(AuthGuard('jwt'))
  async getAdminOrders(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getAdminOrders();
  }

  @Patch('admin/orders/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateOrderStatus(
    @Param('id') id: string,
    @Body() dto: { status?: string; trackingNumber?: string },
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.apiService.updateOrderStatus(id, dto.status, dto.trackingNumber);
  }
}
export default ApiController;
