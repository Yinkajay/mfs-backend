require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { ConfigModule } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { configureApplication } = require('../dist/configure-app');
const { validateEnvironment } = require('../dist/config/environment');
const { HealthModule } = require('../dist/health/health.module');
const { PrismaService } = require('../dist/prisma/prisma.service');

const databaseUrl = 'postgresql://mfs:test-only@127.0.0.1:5433/mfs';

async function withApp(options, run) {
  let queries = 0;
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [
          () =>
            validateEnvironment({
              NODE_ENV: 'test',
              DATABASE_URL: databaseUrl,
              SWAGGER_ENABLED: String(options.docsEnabled ?? true),
            }),
        ],
      }),
      HealthModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue({
      async $queryRaw(strings) {
        queries += 1;
        assert.equal(strings.join(''), 'SELECT 1');
        if (options.databaseDown) {
          throw new Error(`Connection failed: ${databaseUrl}`);
        }
        return [{ '?column?': 1 }];
      },
    })
    .compile();

  const app = module.createNestApplication();
  app.useLogger(false);

  try {
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    await run(await app.getUrl(), () => queries);
  } finally {
    await app.close();
  }
}

test('environment configuration validates values and applies safe defaults', () => {
  const config = validateEnvironment({ DATABASE_URL: databaseUrl });
  assert.equal(config.PORT, 3001);
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.SWAGGER_ENABLED, true);
  assert.equal(
    validateEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      AUTH_ALLOWED_ORIGINS: 'https://mfsservicesng.com',
    }).SWAGGER_ENABLED,
    false,
  );
  assert.equal(
    validateEnvironment({ DATABASE_URL: databaseUrl, SWAGGER_ENABLED: 'false' })
      .SWAGGER_ENABLED,
    false,
  );

  for (const invalid of [
    {},
    { DATABASE_URL: 'https://host/database?secret=never-print-this' },
    { DATABASE_URL: databaseUrl, PORT: 'abc' },
    { DATABASE_URL: databaseUrl, PORT: '65536' },
    { DATABASE_URL: databaseUrl, NODE_ENV: 'invalid' },
    { DATABASE_URL: databaseUrl, SWAGGER_ENABLED: 'yes' },
  ]) {
    assert.throws(
      () => validateEnvironment(invalid),
      (error) => {
        assert.match(error.message, /Invalid backend environment/);
        assert.ok(!error.message.includes('never-print-this'));
        assert.ok(!error.message.includes(databaseUrl));
        return true;
      },
    );
  }
});

test('versioned liveness and readiness routes use separate checks', async () => {
  await withApp({}, async (url, queries) => {
    const live = await fetch(`${url}/v1/health`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });
    assert.equal(queries(), 0);

    const ready = await fetch(`${url}/v1/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      status: 'ready',
      checks: { database: 'up' },
    });
    assert.equal(queries(), 1);
    assert.equal((await fetch(`${url}/health`)).status, 404);
  });
});

test('a database outage fails readiness without leaking connection details', async () => {
  await withApp({ databaseDown: true }, async (url) => {
    assert.equal((await fetch(`${url}/v1/health`)).status, 200);
    const response = await fetch(`${url}/v1/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: 'not_ready',
      checks: { database: 'down' },
    });
  });
});

test('OpenAPI documents the versioned routes and readiness failure', async () => {
  await withApp({}, async (url) => {
    const response = await fetch(`${url}/v1/docs-json`);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.info.title, 'MFS Services API');
    assert.ok(document.paths['/v1/health']);
    assert.ok(document.paths['/v1/health/ready'].get.responses['503']);
    assert.equal((await fetch(`${url}/v1/docs`)).status, 200);
  });
});

test('OpenAPI endpoints are absent when documentation is disabled', async () => {
  await withApp({ docsEnabled: false }, async (url) => {
    assert.equal((await fetch(`${url}/v1/docs-json`)).status, 404);
    assert.equal((await fetch(`${url}/v1/docs`)).status, 404);
    assert.equal((await fetch(`${url}/v1/health`)).status, 200);
  });
});
