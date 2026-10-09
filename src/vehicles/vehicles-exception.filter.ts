import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthRateLimitException } from '../auth/auth-rate-limit.service';

@Catch()
export class VehiclesExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (exception instanceof AuthRateLimitException)
      response.setHeader('Retry-After', String(exception.retryAfter));
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response.status(exception.getStatus()).json({
        statusCode: exception.getStatus(),
        ...(typeof body === 'string' ? { message: body } : body),
      });
      return;
    }
    // Vehicle identifiers, submitted details and driver errors stay private.
    response.status(503).json({
      statusCode: 503,
      message: 'Vehicle services are temporarily unavailable',
    });
  }
}
