import { BadRequestException, Body, Controller, ForbiddenException, Get, Patch, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import crypto from 'crypto';
import { Response } from 'express';
import { signJwt, verifyJwt, parseCookies } from '../api/api.helpers.js';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, authCookieOptions, getJwtSecret } from '../../config/security.config.js';
import { DynamoCatalogService } from './dynamo-catalog.service.js';

@Controller('api/v1')
export class DynamoAuthController {
  constructor(private readonly catalog: DynamoCatalogService) {}

  @Post('auth/google-login')
  async googleLogin(@Body() dto: { idToken: string }, @Res({ passthrough: true }) response: Response) {
    const idToken = String(dto?.idToken || '').trim();
    if (!idToken || idToken.includes('@')) throw new BadRequestException('Google OAuth identity token is required.');
    const isJwt = idToken.split('.').length === 3;
    const googleResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?${isJwt ? 'id_token' : 'access_token'}=${encodeURIComponent(idToken)}`);
    if (!googleResponse.ok) throw new UnauthorizedException('Google login could not be verified.');
    const payload: any = await googleResponse.json();
    const allowed = [process.env.GOOGLE_CLIENT_ID, process.env.VITE_GOOGLE_CLIENT_ID,
      '984738691172-khs7a7lp6ccgk56e089b4gbfs8k48bsa.apps.googleusercontent.com',
      '231477217878-0g2nq0e6fmvqt802gdu8esm1uucfmjvv.apps.googleusercontent.com'].filter(Boolean);
    if (!allowed.includes(payload.aud || payload.azp)) throw new UnauthorizedException('Google OAuth client identification mismatch.');
    if (!payload.email || (payload.email_verified !== undefined && !['true', true].includes(payload.email_verified))) {
      throw new UnauthorizedException('A verified Google email address is required.');
    }
    const user = await this.catalog.syncGoogleUser(String(payload.email));
    const secret = getJwtSecret();
    const accessToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, ACCESS_TOKEN_TTL_SECONDS);
    const refreshToken = signJwt({ userId: user.id, email: user.email, role: user.role }, secret, REFRESH_TOKEN_TTL_SECONDS);
    await this.catalog.updateRefreshToken(user.id, refreshToken);
    response.cookie('gk_access_token', accessToken, authCookieOptions(ACCESS_TOKEN_TTL_SECONDS * 1000));
    response.cookie('gk_refresh_token', refreshToken, authCookieOptions(REFRESH_TOKEN_TTL_SECONDS * 1000));
    return { success: true, user };
  }

  @Post('auth/refresh')
  async refresh(@Req() request: any, @Res({ passthrough: true }) response: Response) {
    const token = parseCookies(request.headers.cookie || '').gk_refresh_token;
    const payload: any = token ? verifyJwt(token, getJwtSecret()) : null;
    if (!payload?.userId || !(await this.catalog.verifyRefreshToken(payload.userId, token))) {
      response.clearCookie('gk_access_token', { path: '/' });
      response.clearCookie('gk_refresh_token', { path: '/' });
      throw new UnauthorizedException('Refresh token is invalid or revoked.');
    }
    const user = await this.catalog.getUserById(payload.userId);
    if (!user) throw new UnauthorizedException('User no longer exists.');
    const access = signJwt({ userId: user.id, email: user.email, role: user.role }, getJwtSecret(), ACCESS_TOKEN_TTL_SECONDS);
    const rotated = signJwt({ userId: user.id, email: user.email, role: user.role }, getJwtSecret(), REFRESH_TOKEN_TTL_SECONDS);
    if (await this.catalog.rotateRefreshToken(user.id, token, rotated)) response.cookie('gk_refresh_token', rotated, authCookieOptions(REFRESH_TOKEN_TTL_SECONDS * 1000));
    response.cookie('gk_access_token', access, authCookieOptions(ACCESS_TOKEN_TTL_SECONDS * 1000));
    return { success: true };
  }

  @Post('auth/logout')
  async logout(@Req() request: any, @Res({ passthrough: true }) response: Response) {
    const token = parseCookies(request.headers.cookie || '').gk_access_token;
    const payload: any = token ? verifyJwt(token, getJwtSecret()) : null;
    if (payload?.userId) await this.catalog.updateRefreshToken(payload.userId, null);
    response.clearCookie('gk_access_token', { path: '/' });
    response.clearCookie('gk_refresh_token', { path: '/' });
    return { success: true };
  }

  @Get('auth/me')
  @UseGuards(AuthGuard('jwt'))
  me(@Req() request: any) { return { user: request.user }; }

  @Patch('admin/users/role')
  @UseGuards(AuthGuard('jwt'))
  role(@Body() dto: any, @Req() request: any) {
    if (request.user?.role !== 'Owner') throw new ForbiddenException('Only the owner can change user roles.');
    return this.catalog.setUserRole(dto.email, dto.role);
  }
}
