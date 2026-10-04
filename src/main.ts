import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Environment } from './config/environment';
import { configureApplication } from './configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
    bodyParser: false,
  });

  try {
    configureApplication(app);
    app.enableShutdownHooks();
    const config = app.get<ConfigService<Environment, true>>(ConfigService);
    await app.listen(
      config.get('PORT', { infer: true }),
      config.get('HOST', { infer: true }),
    );
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    error instanceof Error ? error.message : 'Unknown startup failure',
    'Bootstrap',
  );
  process.exitCode = 1;
});
