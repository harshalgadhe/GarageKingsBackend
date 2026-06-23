import * as crypto from 'crypto';

// ── PASSWORD HASHING (PBKDF2 SH512) ───────────────────────────────
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}

// ── JWT GENERATION & VERIFICATION (HMAC SHA256) ───────────────────
function base64url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function signJwt(payload: any, secret: string, expiresInSeconds: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const fullPayload = { ...payload, exp };
  
  const part1 = base64url(Buffer.from(JSON.stringify(header)));
  const part2 = base64url(Buffer.from(JSON.stringify(fullPayload)));
  const data = part1 + '.' + part2;
  
  const signature = crypto.createHmac('sha256', secret).update(data).digest();
  return data + '.' + base64url(signature);
}

export function verifyJwt(token: string, secret: string): any {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  
  const [part1, part2, signature] = parts;
  const data = part1 + '.' + part2;
  
  const expectedSignature = base64url(crypto.createHmac('sha256', secret).update(data).digest());
  if (signature !== expectedSignature) return null;
  
  try {
    const payload = JSON.parse(Buffer.from(part2, 'base64').toString('utf8'));
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return null; // Token expired
    }
    return payload;
  } catch (e) {
    return null;
  }
}

// ── IMAGE MAGIC BYTES SIGNATURE CHECK ─────────────────────────────
export function validateFileSignature(buffer: Buffer): { isValid: boolean; mime: string } {
  if (!buffer || buffer.length < 12) return { isValid: false, mime: '' };
  
  const hex = buffer.toString('hex', 0, 12).toLowerCase();
  
  // JPEG check: ffd8ff
  if (hex.startsWith('ffd8ff')) {
    return { isValid: true, mime: 'image/jpeg' };
  }
  // PNG check: 89504e47
  if (hex.startsWith('89504e47')) {
    return { isValid: true, mime: 'image/png' };
  }
  // WEBP check: 52494646 (RIFF) ... 57454250 (WEBP)
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') {
    return { isValid: true, mime: 'image/webp' };
  }
  
  return { isValid: false, mime: '' };
}

// ── IN-MEMORY CACHE (REDIS MOCK PROVIDER) ──────────────────────────
class InMemoryCache {
  private cache = new Map<string, { value: any; expiresAt: number }>();

  set(key: string, value: any, ttlSeconds?: number): void {
    const expiresAt = ttlSeconds ? Date.now() + (ttlSeconds * 1000) : Infinity;
    this.cache.set(key, { value, expiresAt });
  }

  get(key: string): any {
    const data = this.cache.get(key);
    if (!data) return null;
    if (data.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return data.value;
  }

  del(key: string): void {
    this.cache.delete(key);
  }

  incr(key: string, ttlSeconds?: number): number {
    const current = this.get(key);
    const newVal = (Number(current) || 0) + 1;
    this.set(key, newVal, ttlSeconds);
    return newVal;
  }
}

export const localCache = new InMemoryCache();

// ── COOKIE PARSER UTILITY ─────────────────────────────────────────
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const parts = c.split('=');
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  });
  return cookies;
}
