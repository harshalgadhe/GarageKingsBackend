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

    const normalized = this.normalizeException(exception);
    const status = normalized.status;

    const internalMessage = normalized.internalMessage;
    const message = normalized.publicMessage;
    const stack = exception instanceof Error ? exception.stack : '';
    const correlationId = getCorrelationId();

    // A 401 is a normal part of cookie-session recovery: an expired access token
    // is rejected and the browser retries after refreshing it. Recording that
    // first rejection creates false incidents in the admin diagnostics queue.
    // Authorization failures (403), abuse signals (429), and server faults remain
    // observable. Authentication attempts are still visible in request/audit logs.
    if (status >= 500 || status === 403 || status === 429) {
      this.telemetryService.logError({
        errorType: 'Backend',
        message: internalMessage,
        stackTrace: stack,
        exceptionType: exception.name || 'Error',
        severity: status >= 500 ? 'Fatal' : 'Warning',
        endpoint: `${request.method} ${request.url.split('?')[0]}`,
        route: request.route?.path || request.url,
        userId: request.user?.id,
        userEmail: request.user?.email,
        correlationId: correlationId,
        payload: this.redact(request.body),
        browser: request.headers['user-agent']
      }).catch(err => console.error('Failed to log telemetry exception:', err));
    }

    if (status >= 500) {
      // Never dump QueryFailedError parameters: they may contain customer data,
      // uploaded asset URLs, or other request fields.
      console.error('[Unhandled API error]', {
        name: exception?.name || 'Error',
        message: internalMessage,
        code: exception?.code || exception?.driverError?.code,
        constraint: exception?.constraint || exception?.driverError?.constraint,
        endpoint: `${request.method} ${request.url.split('?')[0]}`,
        correlationId,
        stack
      });
    }

    response.status(status).json({
      statusCode: status,
      message: message,
      error: normalized.errorName,
      timestamp: new Date().toISOString(),
      correlationId: correlationId
    });
  }

  private normalizeException(exception: any): {
    status: number;
    internalMessage: string;
    publicMessage: string;
    errorName: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse() as any;
      const responseMessage = typeof response === 'string' ? response : response?.message;
      return {
        status,
        internalMessage: exception.message || 'Request failed',
        publicMessage: Array.isArray(responseMessage) ? responseMessage.join(' ') : (responseMessage || exception.message),
        errorName: exception.name || 'HttpException'
      };
    }

    const code = exception?.code || exception?.driverError?.code;
    if (code === '23505') {
      return {
        status: HttpStatus.CONFLICT,
        internalMessage: exception?.message || 'Unique constraint violation',
        publicMessage: 'A record with the same unique value already exists.',
        errorName: 'ConflictException'
      };
    }
    if (code === '23503') {
      return {
        status: HttpStatus.CONFLICT,
        internalMessage: exception?.message || 'Foreign key constraint violation',
        publicMessage: 'This record is still linked to other data and cannot be changed that way.',
        errorName: 'ConflictException'
      };
    }
    if (code === '22P02' || code === '23502') {
      return {
        status: HttpStatus.BAD_REQUEST,
        internalMessage: exception?.message || 'Invalid database value',
        publicMessage: 'One or more submitted values are missing or invalid.',
        errorName: 'BadRequestException'
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      internalMessage: exception instanceof Error ? exception.message : 'An unexpected error occurred',
      publicMessage: 'An internal server error occurred.',
      errorName: exception?.name || 'Error'
    };
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
