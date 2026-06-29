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
    const accessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 15 * 60); // 15 mins
    const refreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 7 * 24 * 60 * 60); // 7 days

    await this.apiService.updateRefreshToken(user.id, refreshToken);

    res.cookie('gk_access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000
    });

    res.cookie('gk_refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
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
    const accessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 15 * 60); // 15 mins
    const refreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 7 * 24 * 60 * 60); // 7 days

    await this.apiService.updateRefreshToken(user.id, refreshToken);

    res.cookie('gk_access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000
    });

    res.cookie('gk_refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
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

    const newAccessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 15 * 60);
    const newRefreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, 7 * 24 * 60 * 60);

    await this.apiService.updateRefreshToken(user.id, newRefreshToken);

    res.cookie('gk_access_token', newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000
    });

    res.cookie('gk_refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
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
      const accessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, jwtSecret, 15 * 60); // 15 mins
      const refreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, jwtSecret, 7 * 24 * 60 * 60); // 7 days

      await this.apiService.updateRefreshToken(user.id, refreshToken);

      res.cookie('gk_access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 15 * 60 * 1000
      });

      res.cookie('gk_refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
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

  @Get('admin/orders')
  @UseGuards(AuthGuard('jwt'))
  async getAdminOrders(
    @Query('page') page: number,
    @Query('limit') limit: number,
    @Query('search') search: string,
    @Query('status') status: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    if (page || limit || search || status) {
      return this.apiService.getPaginatedAdminOrders({ page, limit, search, status });
    }
    return this.apiService.getAdminOrders();
  }


  @Patch('admin/orders/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateOrderStatus(
    @Param('id') id: string,
    @Body() dto: { status?: string; courierPartner?: string; trackingNumber?: string; shippingCost?: number; packagingCost?: number; dispatchDate?: string; deliveryDate?: string },
    @Request() req: any
  ) {
    this.checkAdmin(req);
    if (dto.status === 'Confirmed') {
      return this.apiService.adminConfirmOrder(id, req.user.email, req.ip);
    }
    return this.apiService.adminUpdateOrderStatus(id, dto, req.user.email, req.ip);
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

  @Get('admin/orders/:id/screenshot')
  @UseGuards(AuthGuard('jwt'))
  async getScreenshot(@Param('id') orderId: string, @Request() req: any, @Res() res: ExpressResponse) {
    this.checkAdmin(req);
    const result = await this.apiService.getPrivateScreenshotStream(orderId);
    if (!result) {
      throw new NotFoundException('Screenshot not found for this order.');
    }
    res.setHeader('Content-Type', 'image/jpeg'); // Standard default, browser handles webp/png inline mostly
    result.stream.pipe(res);
  }

  // ── PRE-ORDER: COLLECT REMAINING PAYMENT ──────────────────────────
  @Post('admin/orders/:id/collect-remaining')
  @UseGuards(AuthGuard('jwt'))
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

  // ── FORMAL RECEIPT GENERATION ─────────────────────────────────────
  @Get('admin/orders/:id/receipt')
  @UseGuards(AuthGuard('jwt'))
  async getOrderReceipt(@Param('id') orderId: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.generateReceiptForOrder(orderId);
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

  @Get('admin/dashboard/kpis')
  @UseGuards(AuthGuard('jwt'))
  async getDashboardKpis(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getFinanceMetrics();
  }

  // ── ANALYTICS METRICS ──────────────────────────────────────────────
  @Get('admin/analytics')
  @UseGuards(AuthGuard('jwt'))
  async getAnalytics(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getAnalyticsMetrics();
  }

  // ── AUDIT LOGS ────────────────────────────────────────────────────
  @Get('admin/audit-logs')
  @UseGuards(AuthGuard('jwt'))
  async getAuditLogs(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getAuditLogs();
  }

  // ── ALERTS AND SYSTEM NOTIFICATIONS ───────────────────────────────
  @Get('admin/notifications')
  @UseGuards(AuthGuard('jwt'))
  async getNotifications(@Request() req: any, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    this.checkAdmin(req);
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const offsetNum = offset ? parseInt(offset, 10) : 0;
    return this.apiService.getSystemNotifications(limitNum, offsetNum);
  }

  @Post('admin/notifications/read')
  @UseGuards(AuthGuard('jwt'))
  async markNotificationsRead(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.markNotificationsRead();
  }

  @Delete('admin/notifications/:id')
  @UseGuards(AuthGuard('jwt'))
  async deleteNotification(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.deleteSystemNotification(id);
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
}
export default ApiController;

