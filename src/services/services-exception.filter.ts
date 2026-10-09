import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class ServicesExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response.status(exception.getStatus()).json({
        statusCode: exception.getStatus(),
        ...(typeof body === 'string' ? { message: body } : body),
      });
      return;
    }
    response.status(503).json({
      statusCode: 503,
      message: 'Service catalogue is temporarily unavailable',
    });
  }
}
