import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Environment } from './config/environment';

export function configureApplication(app: INestApplication): void {
  app.setGlobalPrefix('v1');

  const config = app.get<ConfigService<Environment, true>>(ConfigService);
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const documentConfig = new DocumentBuilder()
      .setTitle('MFS Services API')
      .setDescription('MFS backend foundation. REST endpoints are under /v1.')
      .setVersion('0.1.0')
      .build();

    const document = SwaggerModule.createDocument(app, documentConfig);
    SwaggerModule.setup('v1/docs', app, document, {
      jsonDocumentUrl: 'v1/docs-json',
    });
  }
}
