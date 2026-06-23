import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import dotenv from 'dotenv';

dotenv.config();

function parseCookies(cookieHeader: string) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const parts = c.split('=');
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  });
  return cookies;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => {
          if (req.headers.cookie) {
            const cookies = parseCookies(req.headers.cookie);
            return cookies['gk_access_token'] || null;
          }
          return null;
        }
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'gk_development_secure_fallback_jwt_signing_key_2026',
      algorithms: ['HS256']
    });
  }

  async validate(payload: any) {
    if (!payload || !payload.userId) {
      throw new UnauthorizedException('Invalid token session.');
    }
    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role || 'Viewer'
    };
  }
}
export default JwtStrategy;
