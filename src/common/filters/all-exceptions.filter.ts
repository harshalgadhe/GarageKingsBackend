import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Log the full exception details on the server console for CloudWatch/local debugging
    console.error('[Global Exception Handler caught error]:', exception);

    const message = exception instanceof Error ? exception.message : 'An unexpected error occurred';

    response.status(status).json({
      statusCode: status,
      message: message,
      error: exception.name || 'Error',
      timestamp: new Date().toISOString()
    });
  }
}
export default AllExceptionsFilter;
