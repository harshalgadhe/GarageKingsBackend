import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { TelemetryService } from '../../modules/observability/services/telemetry.service.js';
import { getCorrelationId } from '../middleware/trace-context.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly telemetryService: TelemetryService) {}

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<any>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const internalMessage = exception instanceof Error ? exception.message : 'An unexpected error occurred';
    const message = status >= 500 ? 'An internal server error occurred.' : internalMessage;
    const stack = exception instanceof Error ? exception.stack : '';
    const correlationId = getCorrelationId();

    // Log the full exception details in TelemetryService
    this.telemetryService.logError({
      errorType: 'Backend',
      message: internalMessage,
      stackTrace: stack,
      exceptionType: exception.name || 'Error',
      severity: status >= 500 ? 'Fatal' : 'Error',
      endpoint: `${request.method} ${request.url.split('?')[0]}`,
      route: request.route?.path || request.url,
      userId: request.user?.id,
      userEmail: request.user?.email,
      correlationId: correlationId,
      payload: this.redact(request.body),
      browser: request.headers['user-agent']
    }).catch(err => console.error('Failed to log telemetry exception:', err));

    // Log the full exception details on the server console for CloudWatch/local debugging
    console.error('[Global Exception Handler caught error]:', exception);

    response.status(status).json({
      statusCode: status,
      message: message,
      error: exception.name || 'Error',
      timestamp: new Date().toISOString(),
      correlationId: correlationId
    });
  }

  private redact(value: any): any {
    if (!value || typeof value !== 'object') return undefined;
    const sensitive = /password|passcode|token|authorization|cookie|secret|upi|card|cvv|account|screenshot|payment/i;
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => this.redact(item));
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
      key,
      sensitive.test(key) ? '[REDACTED]' : (item && typeof item === 'object' ? this.redact(item) : item)
    ]));
  }
}
export default AllExceptionsFilter;
