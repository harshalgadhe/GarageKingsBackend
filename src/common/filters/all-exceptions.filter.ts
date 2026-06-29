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

    const message = exception instanceof Error ? exception.message : 'An unexpected error occurred';
    const stack = exception instanceof Error ? exception.stack : '';
    const correlationId = getCorrelationId();

    // Log the full exception details in TelemetryService
    this.telemetryService.logError({
      errorType: 'Backend',
      message: message,
      stackTrace: stack,
      exceptionType: exception.name || 'Error',
      severity: status >= 500 ? 'Fatal' : 'Error',
      endpoint: `${request.method} ${request.url.split('?')[0]}`,
      route: request.route?.path || request.url,
      userId: request.user?.id,
      userEmail: request.user?.email,
      correlationId: correlationId,
      payload: request.body,
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
}
export default AllExceptionsFilter;

