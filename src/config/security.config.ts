const DEVELOPMENT_JWT_SECRET = 'local-development-only-change-before-production-2026';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be configured with at least 32 characters in production.');
  }
  return DEVELOPMENT_JWT_SECRET;
}

export function getAllowedOrigins(): string[] {
  const configured = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const defaults = [
    'https://garagekingsindia.com',
    'https://www.garagekingsindia.com'
  ];
  if (process.env.NODE_ENV !== 'production') {
    defaults.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }
  return [...new Set([...defaults, ...configured])];
}

export function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;
  return getAllowedOrigins().includes(origin);
}

export const authCookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge
});
