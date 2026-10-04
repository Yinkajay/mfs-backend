import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthRateLimitException } from './auth-rate-limit.service';

@Catch()
export class AuthExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (exception instanceof AuthRateLimitException)
      response.setHeader('Retry-After', String(exception.retryAfter));
    else if (
      exception instanceof HttpException &&
      exception.getStatus() === 429
    )
      response.setHeader('Retry-After', '1');
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response.status(exception.getStatus()).json({
        statusCode: exception.getStatus(),
        ...(typeof body === 'string' ? { message: body } : body),
      });
      return;
    }
    // Never serialize/log Prisma errors, credentials, submitted values, or hashes.
    response.status(503).json({
      statusCode: 503,
      message: 'Authentication is temporarily unavailable',
    });
  }
}
