import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';
import { databaseConnectionUrl } from './src/prisma/connection-url';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Neon migrations use the direct endpoint; the API still uses DATABASE_URL.
  datasource: {
    url: databaseConnectionUrl(
      process.env.DATABASE_URL_UNPOOLED || env('DATABASE_URL'),
    ),
  },
});
