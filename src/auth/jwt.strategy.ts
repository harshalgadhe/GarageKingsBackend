import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const userPoolId = process.env.COGNITO_USER_POOL_ID || 'ap-south-1_YaTasZ9v0';
    const awsRegion = process.env.COGNITO_AWS_REGION || 'ap-south-1';
    const clientId = process.env.COGNITO_CLIENT_ID || '6f55rbspec5p04tdd83l7c2uc0';

    const jwksUri = `https://cognito-idp.${awsRegion}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => {
          const customHeader = req.headers['x-authorization'] || req.headers['x-auth-token'];
          if (customHeader) {
            return customHeader.replace(/^bearer\s+/i, '');
          }
          return null;
        }
      ]),
      ignoreExpiration: false,
      audience: clientId,
      issuer: `https://cognito-idp.${awsRegion}.amazonaws.com/${userPoolId}`,
      algorithms: ['RS256'],
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: jwksUri
      })
    });
  }

  // Mapped user callback payload from decoded token attributes
  async validate(payload: any) {
    if (!payload || !payload.sub) {
      throw new UnauthorizedException('Invalid auth signature keys.');
    }
    return {
      userId: payload.sub,
      email: payload.email,
      username: payload['cognito:username'],
      roles: payload['cognito:groups'] || []
    };
  }
}
export default JwtStrategy;
