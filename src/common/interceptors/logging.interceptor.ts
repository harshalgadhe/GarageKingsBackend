import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from '../../modules/observability/services/metrics.service.js';
import { getCorrelationId } from '../middleware/trace-context.js';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    
    const startTime = Date.now();
    const url = req.url;
    const method = req.method;
    const correlationId = getCorrelationId();

    // Skip tracking for health and metrics endpoints to avoid noise
    if (url.includes('/health') || url.includes('/metrics') || url.includes('/telemetry/log')) {
      return next.handle();
    }

    const payloadSize = req.headers['content-length'] ? parseInt(req.headers['content-length'] as string, 10) : 0;

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        const statusCode = res.statusCode;

        let feature = 'Unknown';
        if (url.includes('/auth')) feature = 'Authentication';
        else if (url.includes('/products') || url.includes('/admin/products')) feature = 'Inventory';
        else if (url.includes('/orders') || url.includes('/admin/orders')) feature = 'Orders';
        else if (url.includes('/expenses')) feature = 'Expenses';
        else if (url.includes('/receipts')) feature = 'Invoices';
        else if (url.includes('/settings')) feature = 'Settings';
        else if (url.includes('/profile')) feature = 'Profile';

        this.metricsService.recordMetric({
          metricType: 'api_latency',
          feature,
          endpoint: `${method} ${url.split('?')[0]}`,
          durationMs: duration,
          payloadSizeBytes: payloadSize,
          correlationId,
          userId: req.user?.id,
          metadata: {
            statusCode,
            ip: req.ip,
            userAgent: req.headers['user-agent']
          }
        }).catch(err => console.error('Failed to log performance metric:', err));
      })
    );
  }
}
export default LoggingInterceptor;
