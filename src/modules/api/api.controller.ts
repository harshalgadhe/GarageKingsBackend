import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Request, Res, UnauthorizedException, UseInterceptors, UploadedFile, StreamableFile, BadRequestException, NotFoundException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiService } from './api.service.js';
import { CognitoIdentityProviderClient, AdminConfirmSignUpCommand, AdminUpdateUserAttributesCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import crypto from 'crypto';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response as ExpressResponse } from 'express';
import { signJwt, verifyJwt, validateFileSignature, parseCookies } from './api.helpers.js';

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_AWS_REGION || 'ap-south-1'
});

/**
 * @deprecated Legacy monolithic controller. Endpoints are being migrated to feature modules under `/api/v1/public`, `/api/v1/customer`, and `/api/v1/admin`.
 */
@Controller('api/v1')
export class ApiController {
  constructor(private readonly apiService: ApiService) {}

  // Helper validation ensuring the caller is Owner or Admin
  private checkAdmin(req: any) {
    const role = req.user?.role;
    if (role !== 'Owner' && role !== 'Admin') {
      throw new UnauthorizedException('Administrative privileges required.');
    }
  }

  // ── FIRST STARTUP SETUP STATUS ──────────────────────────────────────
  @Get('setup/status')
  async getSetupStatus() {
    return this.apiService.getSetupStatus();
  }

  @Post('setup/owner')
  async setupOwner(@Body() dto: any) {
    return this.apiService.setupOwner(dto);
  }

  // ── LOCAL AUTH COOKIE-BASED SESSION ENDPOINTS ───────────────────────
  @Post('auth/signup')
  async signup(@Body() dto: any, @Res({ passthrough: true }) res: ExpressResponse) {
    const { email, password, fullName } = dto;
    if (!email || !password) {
      throw new BadRequestException('Email and password are required.');
    }
    const user = await this.apiService.registerUser(email, password, fullName);
    if (!user) {
      throw new BadRequestException('User registration failed.');
    }

    const secret = process.env.JWT_SECRET || 'gk_development_secure_fallback_jwt_signing_key_2026';
    const accessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 30 * 24 * 60 * 60); // 30 days
    const refreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 90 * 24 * 60 * 60); // 90 days

    await this.apiService.updateRefreshToken(user.id, refreshToken);

    res.cookie('gk_access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.cookie('gk_refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 90 * 24 * 60 * 60 * 1000
    });

    return { success: true, user: { id: user.id, email: user.email, role: user.role } };
  }

  @Post('auth/login')
  async login(@Body() dto: any, @Res({ passthrough: true }) res: ExpressResponse) {
    const { email, password } = dto;
    if (!email || !password) {
      throw new BadRequestException('Email and password are required.');
    }
    const user = await this.apiService.validateUserCredentials(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const secret = process.env.JWT_SECRET || 'gk_development_secure_fallback_jwt_signing_key_2026';
    const accessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 30 * 24 * 60 * 60); // 30 days
    const refreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 90 * 24 * 60 * 60); // 90 days

    await this.apiService.updateRefreshToken(user.id, refreshToken);

    res.cookie('gk_access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.cookie('gk_refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 90 * 24 * 60 * 60 * 1000
    });

    return { success: true, user: { id: user.id, email: user.email, role: user.role } };
  }

  @Post('auth/logout')
  async logout(@Request() req: any, @Res({ passthrough: true }) res: ExpressResponse) {
    const accessToken = req.headers.cookie ? parseCookies(req.headers.cookie)['gk_access_token'] : null;
    if (accessToken) {
      const secret = process.env.JWT_SECRET || 'gk_development_secure_fallback_jwt_signing_key_2026';
      const payload = verifyJwt(accessToken, secret);
      if (payload && payload.userId) {
        await this.apiService.updateRefreshToken(payload.userId, null);
      }
    }
    res.clearCookie('gk_access_token');
    res.clearCookie('gk_refresh_token');
    return { success: true };
  }

  @Post('auth/refresh')
  async refresh(@Request() req: any, @Res({ passthrough: true }) res: ExpressResponse) {
    const refreshToken = req.headers.cookie ? parseCookies(req.headers.cookie)['gk_refresh_token'] : null;
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token provided.');
    }

    const secret = process.env.JWT_SECRET || 'gk_development_secure_fallback_jwt_signing_key_2026';
    const payload = verifyJwt(refreshToken, secret);
    if (!payload || !payload.userId) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    const isValid = await this.apiService.verifyRefreshToken(payload.userId, refreshToken);
    if (!isValid) {
      throw new UnauthorizedException('Refresh token is revoked.');
    }

    const user = await this.apiService.getUserById(payload.userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists.');
    }

    const newAccessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 30 * 24 * 60 * 60);
    const newRefreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 90 * 24 * 60 * 60);

    await this.apiService.updateRefreshToken(user.id, newRefreshToken);

    res.cookie('gk_access_token', newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.cookie('gk_refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 90 * 24 * 60 * 60 * 1000
    });

    return { success: true };
  }

  @Get('auth/me')
  @UseGuards(AuthGuard('jwt'))
  async getMe(@Request() req: any) {
    return { user: req.user };
  }

  // ── LEGACY COGNITO BYPASSES ─────────────────────────────────────────
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
  async googleLogin(@Body() dto: { idToken: string }, @Res({ passthrough: true }) res: ExpressResponse) {
    const { idToken } = dto;
    if (!idToken) {
      throw new UnauthorizedException('Google OAuth identity token is required.');
    }

    try {
      let cleanEmail = '';
      let googleName = '';
      let googleGivenName = '';

      if (idToken.includes('@')) {
        // Developer sandbox bypass mode
        console.log(`[GoogleLogin] Sandbox bypass mode detected for email: ${idToken}`);
        cleanEmail = idToken.trim();
      } else {
        // 1. Verify Google Token via tokeninfo endpoint (supports both ID Token and Access Token)
        const isJwt = idToken.split('.').length === 3;
        const verifyUrl = isJwt
          ? `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`
          : `https://oauth2.googleapis.com/tokeninfo?access_token=${idToken}`;
        
        const googleRes = await fetch(verifyUrl);
        if (!googleRes.ok) {
          const errText = await googleRes.text();
          console.error(`[GoogleLogin] Tokeninfo check failed. Status: ${googleRes.status}, Body: ${errText}, URL: ${verifyUrl}`);
          throw new UnauthorizedException('Google OAuth Token signature verification failed.');
        }
        
        const payload: any = await googleRes.json();
        
        // Verify audience matches our Google Client ID
        const envClientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
        const allowedClientIds = [
          '984738691172-khs7a7lp6ccgk56e089b4gbfs8k48bsa.apps.googleusercontent.com',
          '231477217878-0g2nq0e6fmvqt802gdu8esm1uucfmjvv.apps.googleusercontent.com'
        ];
        const clientAud = payload.aud || payload.azp;
        
        const isMatched = (envClientId && clientAud === envClientId) || allowedClientIds.includes(clientAud);
        if (!isMatched) {
          console.error(`[GoogleLogin] Audience mismatch. Expected: ${envClientId} or one of ${allowedClientIds.join(', ')}, Got: ${clientAud}`);
          throw new UnauthorizedException('Google OAuth client identification mismatch.');
        }
        
        if (payload.email_verified !== undefined && payload.email_verified !== 'true' && payload.email_verified !== true) {
          throw new UnauthorizedException('Google email address must be verified.');
        }
        
        cleanEmail = payload.email.trim();
        googleName = payload.name || '';
        googleGivenName = payload.given_name || '';
      }
      
      // 2. Generate a secure, user-specific database password
      const jwtSecret = process.env.JWT_SECRET || 'gk_development_secure_fallback_jwt_signing_key_2026';
      const securePassword = crypto.createHmac('sha256', jwtSecret)
        .update(cleanEmail)
        .digest('hex') + 'aA1!'; 

      // 3. Sync the Google user in local PostgreSQL database
      console.log(`[GoogleLogin] Syncing user to local PostgreSQL: ${cleanEmail}`);
      const user = await this.apiService.syncGoogleUser(cleanEmail, securePassword);

      // 4. Issue local cookie tokens
      const accessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, jwtSecret, 30 * 24 * 60 * 60); // 30 days
      const refreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, jwtSecret, 90 * 24 * 60 * 60); // 90 days

      await this.apiService.updateRefreshToken(user.id, refreshToken);

      res.cookie('gk_access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000
      });

      res.cookie('gk_refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 90 * 24 * 60 * 60 * 1000
      });

      return { 
        success: true, 
        message: 'Google federated login synced successfully',
        user: { id: user.id, email: user.email, role: user.role }
      };
    } catch (error: any) {
      console.error(`[GoogleLogin] Failed to sync Google login:`, error);
      throw new UnauthorizedException(`Google login sync failed: ${error.message}`);
    }
  }

  // ── PRODUCTS REST ENDPOINTS ─────────────────────────────────────────
  @Get('products')
  async getProducts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('brand') brand?: string,
    @Query('scale') scale?: string,
    @Query('tag') tag?: string,
    @Query('search') search?: string,
    @Query('inStock') inStock?: string,
    @Query('preBooking') preBooking?: string
  ) {
    return this.apiService.getPaginatedProducts({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      brand,
      scale,
      tag,
      search,
      inStock: inStock === 'true',
      preBooking: preBooking === 'true'
    });
  }

  @Get('products/:id')
  async getProduct(@Param('id') id: string) {
    const product = await this.apiService.getProduct(id);
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  @Get('admin/variants')
  @UseGuards(AuthGuard('jwt'))
  async getAdminVariants(
    @Query('page') page: number,
    @Query('limit') limit: number,
    @Query('search') search: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.apiService.getAdminVariants({ page, limit, search });
  }

  @Get('admin/inventory/variants/:variantId/details')
  @UseGuards(AuthGuard('jwt'))
  async getInventoryVariantDetails(@Param('variantId') variantId: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getInventoryVariantDetails(variantId);
  }

  @Get('admin/products')
  @UseGuards(AuthGuard('jwt'))
  async getAdminProducts(
    @Query('page') page: number,
    @Query('limit') limit: number,
    @Query('search') search: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    if (page || limit || search) {
      return this.apiService.getPaginatedProducts({ page, limit, search, adminMode: true });
    }
    return this.apiService.getProducts(true);
  }


  @Post('products')
  @UseGuards(AuthGuard('jwt'))
  async addProduct(@Body() car: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addProduct(car, req.user.email, req.ip);
  }

  @Patch('products/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateProduct(@Param('id') id: string, @Body() car: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateProduct(id, car, req.user.email, req.ip);
  }

  @Delete('products/:id')
  @UseGuards(AuthGuard('jwt'))
  async deleteProduct(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.softDeleteProduct(id, req.user.email, req.ip);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('products/reserve')
  async reserveProduct(@Body() dto: any, @Request() req: any) {
    return this.apiService.reserveProduct(dto, req.ip, req.user.userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('products/reserve-cart')
  async reserveProductsCart(@Body() dto: any, @Request() req: any) {
    return this.apiService.reserveProductsCart(dto, req.ip, req.user.userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('products/calculate-checkout')
  async calculateCheckout(@Body() dto: any) {
    return this.apiService.calculateCheckoutPricing(dto);
  }

  // ── SETTINGS REST ENDPOINTS ─────────────────────────────────────────
  @Get('settings')
  async getSettings() {
    return this.apiService.getGlobalSettings();
  }

  @Post('settings')
  @UseGuards(AuthGuard('jwt'))
  async updateSettings(@Body() settings: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateGlobalSettings(settings, req.user.email, req.ip);
  }

  // ── CRM CUSTOMERS REST ENDPOINTS ─────────────────────────────────────
  @Get('customers')
  @UseGuards(AuthGuard('jwt'))
  async getCustomers(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getCustomers();
  }

  // ── CUSTOMER PROFILE & ORDERS REST ENDPOINTS ─────────────────────────
  @Get('orders/my')
  @UseGuards(AuthGuard('jwt'))
  async getMyOrders(@Request() req: any) {
    return this.apiService.getCustomerOrders(req.user.email);
  }

  @Get('profile/my')
  @UseGuards(AuthGuard('jwt'))
  async getMyProfile(@Request() req: any) {
    return this.apiService.getCustomerProfile(req.user.email);
  }

  @Post('profile/my')
  @UseGuards(AuthGuard('jwt'))
  async updateMyProfile(@Body() dto: any, @Request() req: any) {
    return this.apiService.updateCustomerProfile(req.user.email, dto);
  }



  @Post('orders/:id/screenshot')
  @UseGuards(AuthGuard('jwt'))
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

  @Post('orders/:id/submit-remaining-payment')
  @UseGuards(AuthGuard('jwt'))
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



  // ── PUBLIC IMAGE UPLOADS AND STREAMING ────────────────────────────
  @Post('images/upload')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @UploadedFile() file: any,
    @Body('folder') folder: string = 'general',
    @Request() req: any
  ) {
    this.checkAdmin(req);
    if (!file) {
      throw new BadRequestException('No file provided.');
    }
    const signature = validateFileSignature(file.buffer);
    if (!signature.isValid) {
      throw new BadRequestException('Invalid file type.');
    }
    const extension = signature.mime.split('/').pop() || 'webp';
    const filename = `${crypto.randomUUID()}.${extension}`;
    const url = await this.apiService.uploadImage(file.buffer, filename, signature.mime, folder);
    return { success: true, url };
  }

  @Get('images/:filename')
  async getPublicImage(@Param('filename') filename: string, @Res() res: ExpressResponse) {
    const result = await this.apiService.getPublicImageStream(filename);
    if (!result) {
      throw new NotFoundException('Image not found.');
    }
    res.setHeader('Content-Type', 'image/webp');
    result.stream.pipe(res);
  }

  // ── EXPENSES MODULE ───────────────────────────────────────────────
  @Get('admin/expenses')
  @UseGuards(AuthGuard('jwt'))
  async getExpenses(
    @Query('page') page: number,
    @Query('limit') limit: number,
    @Query('search') search: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    if (page || limit || search) {
      return this.apiService.getPaginatedExpenses({ page, limit, search });
    }
    return this.apiService.getExpenses();
  }


  @Post('admin/expenses')
  @UseGuards(AuthGuard('jwt'))
  async addExpense(@Body() exp: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addExpense(exp, req.user.email, req.ip);
  }

  @Delete('admin/expenses/:id')
  @UseGuards(AuthGuard('jwt'))
  async deleteExpense(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.softDeleteExpense(id, req.user.email, req.ip);
  }

  // ── INVENTORY BATCH & DISTRIBUTOR ENDPOINTS ───────────────────────
  @Post('admin/distributors')
  @UseGuards(AuthGuard('jwt'))
  async createDistributor(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.createSupplier(body, req.user.email, req.ip);
  }

  @Get('admin/distributors')
  @UseGuards(AuthGuard('jwt'))
  async getDistributors(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSuppliers();
  }

  @Post('admin/inventory/batches')
  @UseGuards(AuthGuard('jwt'))
  async receiveInventoryBatch(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    const { productId, distributorName, purchasePrice, sellingPrice, quantity, fundedBy } = body;
    return this.apiService.receiveInventoryBatch(productId, distributorName, purchasePrice, sellingPrice, quantity, req.user.email, req.ip, fundedBy);
  }

  @Get('admin/inventory/batches/:productId')
  @UseGuards(AuthGuard('jwt'))
  async getProductBatches(@Param('productId') productId: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getProductBatches(productId);
  }

  @Patch('admin/inventory/batches/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateInventoryBatch(
    @Param('id') id: string,
    @Body() dto: { purchasePrice?: number; quantityAvailable?: number; quantityReceived?: number; supplierId?: string },
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.apiService.updateInventoryBatch(id, dto, req.user.email, req.ip);
  }

  @Post('admin/inventory/adjust')
  @UseGuards(AuthGuard('jwt'))
  async adjustBatchInventory(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    const { batchId, quantityChange, type, reason } = body;
    return this.apiService.adjustBatchInventory(batchId, quantityChange, type, reason, req.user.email, req.ip);
  }

  @Post('admin/inventory/reconcile')
  @UseGuards(AuthGuard('jwt'))
  async triggerReconciliation(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.runInventoryReconciliation(req.user.email);
  }

  // ── FOUNDER SPLITS & FINANCE LEDGER ───────────────────────────────
  @Get('admin/splits')
  @UseGuards(AuthGuard('jwt'))
  async getSplits(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSplits();
  }

  @Post('admin/splits/settle')
  @UseGuards(AuthGuard('jwt'))
  async addSettlement(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    const { from, to, amount, notes, date } = dto;
    return this.apiService.addSettlement(from, to, Number(amount), notes, date);
  }

  @Get('admin/cash-accounts')
  @UseGuards(AuthGuard('jwt'))
  async getCashAccounts(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getCashAccounts();
  }

  @Post('admin/cash-accounts')
  @UseGuards(AuthGuard('jwt'))
  async createCashAccount(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    const { name, type, openingBalance, currency, description } = dto;
    return this.apiService.createCashAccount(name, type, Number(openingBalance), currency, description);
  }

  @Get('admin/cash-ledger')
  @UseGuards(AuthGuard('jwt'))
  async getCashLedger(
    @Query('timeRange') timeRange?: string,
    @Query('cashAccountId') cashAccountId?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Request() req?: any
  ) {
    this.checkAdmin(req);
    return this.apiService.getCashLedger({
      timeRange,
      cashAccountId,
      type,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined
    });
  }

  @Post('admin/cash-ledger/adjust')
  @UseGuards(AuthGuard('jwt'))
  async addLedgerAdjustment(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addLedgerAdjustment(dto, req.user.email, req.ip);
  }

  @Get('admin/founder-ledger')
  @UseGuards(AuthGuard('jwt'))
  async getFounderLedger(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getFounderLedger();
  }

  @Post('admin/founder-ledger/contribute')
  @UseGuards(AuthGuard('jwt'))
  async addFounderContribution(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addFounderContribution(dto, req.user.email, req.ip);
  }

  @Post('admin/founder-ledger/reimburse')
  @UseGuards(AuthGuard('jwt'))
  async addFounderReimbursement(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addFounderReimbursement(dto, req.user.email, req.ip);
  }

  @Get('admin/dashboard/aggregates')
  @UseGuards(AuthGuard('jwt'))
  async getDashboardAggregates(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getDashboardAggregates();
  }

  @Get('admin/dashboard/kpis')
  @UseGuards(AuthGuard('jwt'))
  async getDashboardKpis(@Query('timeRange') timeRange?: string, @Query('cashAccountId') cashAccountId?: string, @Request() req?: any) {
    this.checkAdmin(req);
    return this.apiService.getFinanceMetrics(timeRange, cashAccountId);
  }

  // ── ANALYTICS METRICS ──────────────────────────────────────────────
  @Get('admin/analytics')
  @UseGuards(AuthGuard('jwt'))
  async getAnalytics(@Query('timeRange') timeRange?: string, @Request() req?: any) {
    this.checkAdmin(req);
    return this.apiService.getAnalyticsMetrics(timeRange);
  }

  // ── AUDIT LOGS ────────────────────────────────────────────────────
  @Get('admin/audit-logs')
  @UseGuards(AuthGuard('jwt'))
  async getAuditLogs(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getAuditLogs();
  }


  // ── CMS HOMEPAGE SECTIONS VISIBILITY ──────────────────────────────
  @Get('admin/homepage-cms')
  @UseGuards(AuthGuard('jwt'))
  async getHomepageCms(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getHomepageCMS();
  }

  @Patch('admin/homepage-cms/section')
  @UseGuards(AuthGuard('jwt'))
  async updateHomepageSectionVisibility(@Body() dto: { sectionName: string; isVisible: boolean }, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateHomepageSectionVisibility(dto.sectionName, dto.isVisible);
  }

  // ── SUPPLIERS AND PURCHASES ───────────────────────────────────────
  @Get('admin/suppliers')
  @UseGuards(AuthGuard('jwt'))
  async getSuppliers(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSuppliers();
  }

  @Post('admin/suppliers')
  @UseGuards(AuthGuard('jwt'))
  async createSupplier(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.createSupplier(dto, req.user.email, req.ip);
  }

  @Get('admin/supplier-purchases')
  @UseGuards(AuthGuard('jwt'))
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

  @Get('admin/supplier-purchases/:id')
  @UseGuards(AuthGuard('jwt'))
  async getSupplierPurchaseDetails(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSupplierPurchaseDetails(id);
  }

  @Post('admin/supplier-purchases')
  @UseGuards(AuthGuard('jwt'))
  async addSupplierPurchase(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addSupplierPurchase(dto, req.user.email, req.ip);
  }

  @Post('admin/supplier-purchases/:id/pay')
  @UseGuards(AuthGuard('jwt'))
  async recordSupplierPayment(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.recordSupplierPayment(id, dto, req.user.email, req.ip);
  }

  @Post('admin/supplier-purchases/:id/receive')
  @UseGuards(AuthGuard('jwt'))
  async receiveSupplierShipment(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.receiveSupplierShipment(id, dto, req.user.email, req.ip);
  }

  @Patch('admin/supplier-purchases/:id/status')
  @UseGuards(AuthGuard('jwt'))
  async updateSupplierPurchaseStatus(
    @Param('id') id: string,
    @Body() dto: { status: string },
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.apiService.updateSupplierPurchaseStatus(id, dto.status, req.user.email, req.ip);
  }

  @Get('admin/dashboard/supplier-metrics')
  @UseGuards(AuthGuard('jwt'))
  async getSupplierMetrics(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSupplierMetrics();
  }

  @Post('admin/supplier-purchases/:id/attachments')
  @UseGuards(AuthGuard('jwt'))
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

  @Get('admin/supplier-attachments/:id')
  @UseGuards(AuthGuard('jwt'))
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

  // ==========================================
  //          MASTER DATA CONTROLLERS
  // ==========================================

  // Brands
  @Get('brands')
  async getBrands() {
    return this.apiService.getBrands(false);
  }

  @Get('admin/brands')
  @UseGuards(AuthGuard('jwt'))
  async getAdminBrands(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getBrands(true);
  }

  @Post('admin/brands')
  @UseGuards(AuthGuard('jwt'))
  async createBrand(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.createBrand(body);
  }

  @Patch('admin/brands/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateBrand(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateBrand(id, body);
  }

  @Delete('admin/brands/:id')
  @UseGuards(AuthGuard('jwt'))
  async archiveBrand(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.archiveBrand(id);
  }

  // Manufacturers
  @Get('manufacturers')
  async getManufacturers() {
    return this.apiService.getManufacturers(false);
  }

  @Get('admin/manufacturers')
  @UseGuards(AuthGuard('jwt'))
  async getAdminManufacturers(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getManufacturers(true);
  }

  @Post('admin/manufacturers')
  @UseGuards(AuthGuard('jwt'))
  async createManufacturer(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.createManufacturer(body);
  }

  @Patch('admin/manufacturers/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateManufacturer(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateManufacturer(id, body);
  }

  @Delete('admin/manufacturers/:id')
  @UseGuards(AuthGuard('jwt'))
  async archiveManufacturer(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.archiveManufacturer(id);
  }

  // Scales
  @Get('scales')
  async getScales() {
    return this.apiService.getScales(false);
  }

  @Get('admin/scales')
  @UseGuards(AuthGuard('jwt'))
  async getAdminScales(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getScales(true);
  }

  @Post('admin/scales')
  @UseGuards(AuthGuard('jwt'))
  async createScale(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.createScale(body);
  }

  @Patch('admin/scales/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateScale(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateScale(id, body);
  }

  @Delete('admin/scales/:id')
  @UseGuards(AuthGuard('jwt'))
  async archiveScale(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.archiveScale(id);
  }

  // Series
  @Get('series')
  async getSeries() {
    return this.apiService.getSeries(false);
  }

  @Get('admin/series')
  @UseGuards(AuthGuard('jwt'))
  async getAdminSeries(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSeries(true);
  }

  @Post('admin/series')
  @UseGuards(AuthGuard('jwt'))
  async createSeries(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.createSeries(body);
  }

  @Patch('admin/series/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateSeries(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateSeries(id, body);
  }

  @Delete('admin/series/:id')
  @UseGuards(AuthGuard('jwt'))
  async archiveSeries(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.archiveSeries(id);
  }
}
export default ApiController;

