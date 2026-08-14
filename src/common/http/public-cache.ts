import crypto from 'node:crypto';
import type { Request, Response } from 'express';

export interface PublicCacheOptions {
  browserSeconds?: number;
  edgeSeconds: number;
  staleWhileRevalidateSeconds?: number;
}

export function cachePublicResponse(
  req: Request,
  res: Response,
  payload: unknown,
  options: PublicCacheOptions,
) {
  const serialized = JSON.stringify(payload);
  const etag = `W/"${crypto.createHash('sha256').update(serialized).digest('hex')}"`;
  const browserSeconds = Math.max(0, options.browserSeconds ?? 0);
  const edgeSeconds = Math.max(0, options.edgeSeconds);
  const staleSeconds = Math.max(0, options.staleWhileRevalidateSeconds ?? 0);
  const staleDirective = staleSeconds > 0 ? `, stale-while-revalidate=${staleSeconds}` : '';

  res.setHeader(
    'Cache-Control',
    `public, max-age=${browserSeconds}, s-maxage=${edgeSeconds}${staleDirective}`,
  );
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Origin');

  if (req.headers['if-none-match'] === etag) {
    res.status(304);
    return undefined;
  }
  return payload;
}
