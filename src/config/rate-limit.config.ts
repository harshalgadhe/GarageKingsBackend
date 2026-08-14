import type { ExecutionContext } from '@nestjs/common';
import { isIP } from 'node:net';

const firstHeaderValue = (value: unknown): string => {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.split(',')[0].trim() : '';
};

const normalizeIp = (value: string): string => {
  const bracketed = value.match(/^\[([^\]]+)](?::\d+)?$/)?.[1];
  if (bracketed && isIP(bracketed)) return bracketed;
  if (isIP(value)) return value;
  const ipv4WithPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)?.[1];
  return ipv4WithPort && isIP(ipv4WithPort) ? ipv4WithPort : '';
};

export function getClientIp(req: Record<string, any>): string {
  // CloudFront overwrites these viewer headers before forwarding to the origin.
  // Prefer them over Lambda/API Gateway proxy addresses.
  const forwardedCandidates = [
    req.headers?.['cloudfront-viewer-address'],
    req.headers?.['x-vercel-forwarded-for'],
    req.headers?.['x-forwarded-for'],
    req.headers?.['true-client-ip'],
  ];
  for (const candidate of forwardedCandidates) {
    const normalized = normalizeIp(firstHeaderValue(candidate));
    if (normalized) return normalized;
  }

  const event = req.apiGateway?.event;
  const eventIp = event?.requestContext?.http?.sourceIp || event?.requestContext?.identity?.sourceIp;
  return normalizeIp(String(eventIp || req.ip || req.socket?.remoteAddress || '')) || 'unknown';
}

export function getRequestRateLimit(context: ExecutionContext): number {
  const req = context.switchToHttp().getRequest<Record<string, any>>();
  const method = String(req.method || 'GET').toUpperCase();
  const path = String(req.path || req.originalUrl || '').split('?')[0].toLowerCase();

  if (path.endsWith('/auth/google-login')) return 10;
  if (path.endsWith('/auth/refresh')) return 30;
  if (path.includes('/images/upload')) return 12;
  if (path.includes('/telemetry/log')) return 30;
  if (method === 'GET' && /\/api\/v1\/(brands|manufacturers|scales|series)$/.test(path)) return 240;
  if (method === 'GET' && path.includes('/products')) return 180;
  if (method === 'GET' && path.includes('/images/')) return 600;
  if (path.includes('/admin/')) return method === 'GET' ? 120 : 60;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return 60;
  return 120;
}
