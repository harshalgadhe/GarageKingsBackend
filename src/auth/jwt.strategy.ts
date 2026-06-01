import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const awsRegion = process.env.COGNITO_AWS_REGION || 'ap-south-1';
    
    if (!userPoolId) {
      console.warn("⚠️ Warning: COGNITO_USER_POOL_ID environment variable is missing.");
    }

    const jwksUri = `https://cognito-idp.${awsRegion}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      audience: process.env.COGNITO_CLIENT_ID,
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
