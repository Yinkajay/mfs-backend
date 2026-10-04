import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Environment } from '../config/environment';
import { PrismaClient } from '../generated/prisma/client';
import { databaseConnectionUrl } from './connection-url';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<Environment, true>) {
    const connectionString = databaseConnectionUrl(
      config.get('DATABASE_URL', { infer: true }),
    );
    const schema =
      new URL(connectionString).searchParams.get('schema') ?? 'public';
    const adapter = new PrismaPg(
      {
        connectionString,
        connectionTimeoutMillis: 3000,
        query_timeout: 3000,
        statement_timeout: 3000,
      },
      { schema },
    );

    super({ adapter });
    // Connect lazily so liveness remains available during a database outage.
    // The readiness endpoint checks the actual database connection.
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
