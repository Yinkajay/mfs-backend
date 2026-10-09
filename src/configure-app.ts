import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Environment } from './config/environment';

export function configureApplication(app: INestApplication): void {
  app.setGlobalPrefix('v1');

  const config = app.get<ConfigService<Environment, true>>(ConfigService);
  const server = app.getHttpAdapter().getInstance() as Express;
  server.disable('x-powered-by');
  server.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  app.enableCors({
    origin: config.get('AUTH_ALLOWED_ORIGINS', { infer: true }),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-MFS-CSRF'],
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  // Parser exceptions can include fragments of the submitted JSON/password.
  // Sanitize them before Nest's default external-exception handler sees them.
  const sanitizeBodyErrors: ErrorRequestHandler = (
    error: unknown,
    request,
    response,
    next,
  ) => {
    void request;
    if (error && typeof error === 'object' && 'type' in error) {
      const type = error.type;
      const parsingErrors = [
        'entity.parse.failed',
        'entity.too.large',
        'encoding.unsupported',
        'charset.unsupported',
        'request.aborted',
        'request.size.invalid',
      ];
      if (typeof type === 'string' && parsingErrors.includes(type)) {
        const status =
          type === 'entity.too.large'
            ? 413
            : type.endsWith('.unsupported')
              ? 415
              : 400;
        response.setHeader('Cache-Control', 'no-store');
        response.status(status).json({
          statusCode: status,
          message:
            status === 413
              ? 'Request body is too large'
              : 'Invalid request body',
        });
        return;
      }
    }
    next(error);
  };
  app.use(sanitizeBodyErrors);
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const documentConfig = new DocumentBuilder()
      .setTitle('MFS Services API')
      .setDescription(
        'MFS REST API. POST/PATCH require JSON. All mutations require X-MFS-CSRF: 1. Registration does not create a session; login sets an HttpOnly cookie. Vehicle routes are customer-owned.',
      )
      .setVersion('0.1.0')
      .addCookieAuth(
        config.get('SESSION_COOKIE_SECURE', { infer: true })
          ? '__Host-mfs_session'
          : 'mfs_session',
        { type: 'apiKey', in: 'cookie' },
        'customerSession',
      )
      .build();

    const document = SwaggerModule.createDocument(app, documentConfig);
    SwaggerModule.setup('v1/docs', app, document, {
      jsonDocumentUrl: 'v1/docs-json',
    });
  }
}
