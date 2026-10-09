// Read-only catalogue checks are restricted to the pinned Neon development branch.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client');
const { validateEnvironment } = require('../dist/config/environment');
const { databaseConnectionUrl } = require('../dist/prisma/connection-url');
const {
  verifyNeonDevelopmentTarget,
} = require('../scripts/neon-development.cjs');

async function main() {
  const { configuration, branch } = verifyNeonDevelopmentTarget();
  const database = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseConnectionUrl(configuration.DATABASE_URL),
      connectionTimeoutMillis: 10000,
      query_timeout: 10000,
    }),
  });
  let app;
  let stage = 'setup';
  let checks = 0;
  let failedCheck = '';
  const expect = (condition, label) => {
    if (!condition) failedCheck = label;
    assert.ok(condition, label);
    checks += 1;
  };

  try {
    const { AppModule } = require('../dist/app.module');
    const { configureApplication } = require('../dist/configure-app');
    const config = validateEnvironment({
      ...configuration,
      NODE_ENV: 'test',
      SWAGGER_ENABLED: 'true',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(config))
      .compile();
    app = module.createNestApplication({ bodyParser: false, logger: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();

    stage = 'database seed';
    expect(
      (await database.service.count({ where: { active: true } })) === 19,
      'Exactly 19 active services are seeded',
    );
    expect(
      (await database.serviceVariant.count({ where: { active: true } })) === 5,
      'Exactly five active variants are seeded',
    );
    expect(
      (await database.serviceVehicleCategory.count()) === 95,
      'Every service is linked to all five vehicle categories',
    );

    stage = 'public API';
    const listResponse = await fetch(`${origin}/v1/services`, {
      signal: AbortSignal.timeout(15000),
    });
    expect(listResponse.status === 200, 'Anonymous service list succeeds');
    const list = await listResponse.json();
    expect(list.items.length === 19, 'Service list contains 19 records');
    expect(
      list.items.every(
        (service) =>
          service.description === null &&
          service.vehicleCategories.length === 5 &&
          !Object.hasOwn(service, 'price') &&
          !Object.hasOwn(service, 'pricingStrategy'),
      ),
      'Catalogue leaves unsupported details and pricing unset',
    );
    expect(
      list.items.some(
        (service) =>
          service.code === 'POLICE_REPORT_AND_AFFIDAVIT' &&
          service.name === 'Police Report and Affidavit',
      ),
      'The nineteenth service preserves its confirmed terminology',
    );

    const detailResponse = await fetch(
      `${origin}/v1/services/new-drivers-licence`,
      { signal: AbortSignal.timeout(15000) },
    );
    expect(detailResponse.status === 200, 'Anonymous slug lookup succeeds');
    const detail = await detailResponse.json();
    expect(
      detail.name === 'New Driver’s Licence' &&
        detail.variants.map(({ code }) => code).join(',') ===
          'THREE_YEARS,FIVE_YEARS',
      'Driver’s licence variants are returned in source order',
    );
    expect(
      (await fetch(`${origin}/v1/services/unknown-service`)).status === 404,
      'Unknown slugs return 404',
    );

    stage = 'OpenAPI';
    const document = await (
      await fetch(`${origin}/v1/docs-json`, {
        signal: AbortSignal.timeout(15000),
      })
    ).json();
    expect(
      Boolean(
        document.paths['/v1/services'].get &&
        document.paths['/v1/services/{slug}'].get,
      ),
      'Both public catalogue routes are documented',
    );
    console.log(
      `Neon ${branch.name} service catalogue checks passed: ${checks}.`,
    );
  } catch (error) {
    const code = /^P\d{4}$/.test(String(error?.code)) ? error.code : '';
    console.error(
      `Neon development catalogue check failed at ${stage}: ${failedCheck || 'Connection/request failure'}${code ? ` (${code})` : ''}; ${checks} checks completed.`,
    );
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
    await database.$disconnect();
  }
}

main().catch(() => {
  console.error(
    'Neon development verification failed before catalogue tests; no tests were run.',
  );
  process.exitCode = 1;
});
