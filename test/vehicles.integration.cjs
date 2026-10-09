// Real CRUD/ownership checks are restricted to the pinned Neon development
// compute. Only this run's synthetic customers, vehicles and counters are removed.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client');
const { validateEnvironment } = require('../dist/config/environment');
const { databaseConnectionUrl } = require('../dist/prisma/connection-url');
const { rateLimitKey } = require('../dist/auth/auth-rate-limit.service');
const {
  verifyNeonDevelopmentTarget,
} = require('../scripts/neon-development.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { configuration, branch } = verifyNeonDevelopmentTarget();
  const runId = randomUUID();
  const namespace = `garage-integration:${runId}`;
  const emails = [
    `mfs-garage-a-${runId}@example.test`,
    `mfs-garage-b-${runId}@example.test`,
  ];
  const keys = [];
  for (const scope of ['login:ip', 'register:ip', 'session:ip'])
    for (const address of ['127.0.0.1', '::ffff:127.0.0.1'])
      keys.push(rateLimitKey(namespace, scope, address));
  for (const scope of ['login:account', 'register:account'])
    for (const email of emails)
      keys.push(rateLimitKey(namespace, scope, email));
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
      SESSION_COOKIE_SECURE: 'false',
      AUTH_ALLOWED_ORIGINS: 'http://localhost:3000',
      AUTH_RATE_LIMIT_NAMESPACE: namespace,
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
    const request = (method, route, body, cookie, extraHeaders = {}) =>
      fetch(`${origin}/v1/${route}`, {
        method,
        headers: {
          Origin: 'http://localhost:3000',
          ...(method === 'GET' ? {} : { 'X-MFS-CSRF': '1' }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    stage = 'readiness';
    let ready = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        if ((await request('GET', 'health/ready')).status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Cold development compute may need a retry. */
      }
      await sleep(500);
    }
    expect(ready, 'Database readiness passes');
    const categories = [
      'BIKE',
      'SALOON',
      'SUV_PICKUP',
      'TRUCK',
      'BUS_MINI_TRUCK',
    ];
    const seeded = await database.vehicleCategory.findMany({
      select: { code: true },
    });
    expect(
      categories.every((category) =>
        seeded.some((row) => row.code === category),
      ),
      'All five vehicle categories are seeded',
    );

    stage = 'real customer sessions';
    const cookies = [];
    const users = [];
    for (const email of emails) {
      const input = {
        firstName: 'Garage',
        lastName: 'Integration',
        email,
        phone: '08031234567',
        password: 'garage integration-only password phrase',
      };
      const registration = await request('POST', 'auth/register', input);
      expect(
        registration.status === 202 && !registration.headers.get('set-cookie'),
        'Registration remains separate from login',
      );
      const login = await request('POST', 'auth/login', {
        email,
        password: input.password,
      });
      expect(
        login.status === 200,
        'Customer signs in with existing secure password/session flow',
      );
      cookies.push(login.headers.get('set-cookie').split(';')[0]);
      users.push(await login.json());
      expect(
        users.at(-1).emailVerifiedAt === null,
        'Unverified customer remains permitted',
      );
    }
    const [firstCookie, secondCookie] = cookies;
    const [firstUser, secondUser] = users;
    const fullVehicle = {
      name: '  Family car  ',
      registrationNumber: '  abC - 123 la  ',
      make: ' Toyota ',
      model: 'Camry',
      year: 2019,
      colour: 'Blue',
      chassisNumber: 'test-chassis',
      engineNumber: 'test-engine',
      engineCapacity: '2.5 L',
      usageType: 'PRIVATE',
      stateOfRegistration: 'Lagos',
    };

    stage = 'vehicle create/list/read';
    const vehicles = [];
    for (const category of categories) {
      const response = await request(
        'POST',
        'vehicles',
        { ...fullVehicle, category },
        firstCookie,
      );
      expect(
        response.status === 201,
        'Each category supports vehicle creation',
      );
      const vehicle = await response.json();
      vehicles.push(vehicle);
      expect(
        vehicle.registrationNumber === fullVehicle.registrationNumber &&
          vehicle.registrationNumberNormalized === 'ABC-123LA',
        'Registration is preserved and normalized separately',
      );
      expect(
        vehicle.name === 'Family car' &&
          vehicle.make === 'Toyota' &&
          vehicle.engineCapacity === '2.5 L' &&
          vehicle.year === 2019 &&
          vehicle.chassisNumber === 'test-chassis' &&
          vehicle.engineNumber === 'test-engine',
        'Vehicle detail fields persist',
      );
      expect(
        !['ownership', 'userId', 'passwordHash', 'tokenHash'].some((key) =>
          Object.hasOwn(vehicle, key),
        ),
        'Vehicle response excludes ownership internals and account secrets',
      );
      const ownership = await database.vehicleOwnership.findUnique({
        where: { vehicleId: vehicle.id },
      });
      expect(
        ownership.userId === firstUser.id,
        'Ownership is derived from the authenticated session',
      );
    }
    const minimal = await request(
      'POST',
      'vehicles',
      { category: 'BIKE' },
      firstCookie,
    );
    expect(
      minimal.status === 201 &&
        (await minimal.json()).registrationNumber === null,
      'An unregistered vehicle can be saved',
    );
    const duplicate = await request(
      'POST',
      'vehicles',
      { category: 'SALOON', registrationNumber: 'ABC-123LA' },
      secondCookie,
    );
    expect(
      duplicate.status === 201,
      'A duplicate plate across customers is allowed',
    );
    const secondVehicle = await duplicate.json();
    const listing = await (
      await request('GET', 'vehicles?limit=1&offset=1', undefined, firstCookie)
    ).json();
    expect(
      listing.items.length === 1 && listing.total === 6 && listing.offset === 1,
      'Garage list pagination counts only the current customer',
    );
    const secondListing = await (
      await request('GET', 'vehicles', undefined, secondCookie)
    ).json();
    expect(
      secondListing.total === 1 &&
        secondListing.items[0].id === secondVehicle.id,
      'Second customer sees only its own vehicle',
    );
    const searched = await (
      await request(
        'GET',
        'vehicles?registrationNumber=abC%20-%20123%20la',
        undefined,
        firstCookie,
      )
    ).json();
    expect(
      searched.total === 5,
      'Normalized registration search remains owner-scoped',
    );
    expect(
      searched.items.every((vehicle) => vehicle.name === 'Family car'),
      'Names persist in the owner-scoped list',
    );

    stage = 'cross-customer ownership enforcement';
    const firstVehicle = vehicles[0];
    const missingId = randomUUID();
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const body =
        method === 'PATCH'
          ? { colour: 'Stolen change', name: 'Stolen name' }
          : undefined;
      const foreign = await request(
        method,
        `vehicles/${firstVehicle.id}`,
        body,
        secondCookie,
      );
      const missing = await request(
        method,
        `vehicles/${missingId}`,
        body,
        secondCookie,
      );
      expect(
        foreign.status === 404 &&
          missing.status === 404 &&
          JSON.stringify(await foreign.json()) ===
            JSON.stringify(await missing.json()),
        'Foreign and missing vehicles are indistinguishable for each operation',
      );
    }
    const untouched = await (
      await request(
        'GET',
        `vehicles/${firstVehicle.id}`,
        undefined,
        firstCookie,
      )
    ).json();
    expect(
      untouched.colour === 'Blue' && untouched.name === 'Family car',
      'Unauthorized update/delete leaves the vehicle unchanged',
    );
    for (const [method, route, body] of [
      ['GET', 'vehicles'],
      ['GET', `vehicles/${firstVehicle.id}`],
      ['POST', 'vehicles', { category: 'BIKE' }],
      ['PATCH', `vehicles/${firstVehicle.id}`, { colour: 'Red' }],
      ['DELETE', `vehicles/${firstVehicle.id}`],
    ])
      expect(
        (await request(method, route, body)).status === 401,
        'Every route denies anonymous callers',
      );

    stage = 'updates, validation and CSRF';
    const changed = await request(
      'PATCH',
      `vehicles/${firstVehicle.id}`,
      {
        registrationNumber: ' xyZ 456 ',
        colour: ' Red ',
        name: '  Work car  ',
      },
      firstCookie,
    );
    expect(changed.status === 200, 'The owner may update its vehicle');
    const updated = await changed.json();
    expect(
      updated.registrationNumber === ' xyZ 456 ' &&
        updated.registrationNumberNormalized === 'XYZ456' &&
        updated.make === 'Toyota' &&
        updated.name === 'Work car' &&
        updated.colour === 'Red',
      'Patch updates paired registration and preserves omitted fields',
    );
    const cleared = await (
      await request(
        'PATCH',
        `vehicles/${firstVehicle.id}`,
        { registrationNumber: null, name: null },
        firstCookie,
      )
    ).json();
    expect(
      cleared.name === null &&
        cleared.registrationNumber === null &&
        cleared.registrationNumberNormalized === null,
      'Null clears both registration fields',
    );
    expect(
      (
        await (
          await request(
            'GET',
            `vehicles/${firstVehicle.id}`,
            undefined,
            firstCookie,
          )
        ).json()
      ).name === null,
      'Cleared vehicle name persists',
    );
    for (const name of [' ', 'x'.repeat(81), 'bad\u200bname']) {
      expect(
        (
          await request(
            'PATCH',
            `vehicles/${firstVehicle.id}`,
            { name },
            firstCookie,
          )
        ).status === 400,
        'Invalid names are rejected by the API',
      );
    }
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const route =
        method === 'POST' ? 'vehicles' : `vehicles/${firstVehicle.id}`;
      const body =
        method === 'POST'
          ? { category: 'BIKE' }
          : method === 'PATCH'
            ? { colour: 'Red' }
            : undefined;
      expect(
        (await request(method, route, body, firstCookie, { 'X-MFS-CSRF': '' }))
          .status === 403,
        'Every garage mutation requires CSRF protection',
      );
    }
    expect(
      (
        await request(
          'PATCH',
          `vehicles/${firstVehicle.id}`,
          { userId: secondUser.id },
          firstCookie,
        )
      ).status === 400,
      'Owner transfer fields are rejected',
    );
    expect(
      (await request('PATCH', `vehicles/${firstVehicle.id}`, {}, firstCookie))
        .status === 400,
      'Empty patches are rejected',
    );
    expect(
      (await request('POST', 'vehicles', { category: 'UNKNOWN' }, firstCookie))
        .status === 400,
      'Unknown categories are rejected',
    );
    expect(
      (await request('GET', 'vehicles?limit=101', undefined, firstCookie))
        .status === 400,
      'Unbounded lists are rejected',
    );
    expect(
      (
        await request('GET', 'vehicles', undefined, firstCookie, {
          Origin: 'https://untrusted.example',
        })
      ).status === 403,
      'Exact origin restriction is preserved',
    );

    stage = 'customer account boundary';
    await database.user.update({
      where: { id: firstUser.id },
      data: { kind: 'STAFF' },
    });
    expect(
      (await request('GET', 'vehicles', undefined, firstCookie)).status === 401,
      'Staff identities cannot use the customer garage',
    );
    await database.user.update({
      where: { id: firstUser.id },
      data: { kind: 'CUSTOMER', status: 'DISABLED' },
    });
    expect(
      (await request('GET', 'vehicles', undefined, firstCookie)).status === 401,
      'Disabled customers cannot use the garage',
    );
    await database.user.update({
      where: { id: firstUser.id },
      data: { status: 'ACTIVE' },
    });

    stage = 'delete and session revocation';
    expect(
      (
        await request(
          'DELETE',
          `vehicles/${firstVehicle.id}`,
          undefined,
          firstCookie,
        )
      ).status === 204,
      'The owner may delete with no request body',
    );
    expect(
      (await database.vehicleOwnership.findUnique({
        where: { vehicleId: firstVehicle.id },
      })) === null,
      'Deleting a vehicle removes only its ownership link',
    );
    expect(
      (
        await request(
          'GET',
          `vehicles/${firstVehicle.id}`,
          undefined,
          firstCookie,
        )
      ).status === 404,
      'Deleted vehicle is no longer readable',
    );
    expect(
      (
        await request(
          'GET',
          `vehicles/${secondVehicle.id}`,
          undefined,
          secondCookie,
        )
      ).status === 200,
      'Other customer’s vehicle survives deletion',
    );
    expect(
      (await request('POST', 'auth/logout', {}, firstCookie)).status === 204,
      'Existing logout flow remains working',
    );
    expect(
      (await request('GET', 'vehicles', undefined, firstCookie)).status === 401,
      'Revoked sessions cannot access vehicles',
    );

    stage = 'OpenAPI';
    const document = await (await request('GET', 'docs-json')).json();
    expect(
      document.components.schemas.CreateVehicleDto.properties.name.maxLength ===
        80 &&
        document.components.schemas.CreateVehicleDto.properties.name
          .nullable === true,
      'OpenAPI documents the optional vehicle name',
    );
    expect(
      Boolean(
        document.paths['/v1/vehicles'].post &&
        document.paths['/v1/vehicles'].get &&
        document.paths['/v1/vehicles/{id}'].get &&
        document.paths['/v1/vehicles/{id}'].patch &&
        document.paths['/v1/vehicles/{id}'].delete,
      ),
      'All five vehicle operations are documented',
    );
    console.log(
      `Neon ${branch.name} vehicle integration checks passed: ${checks}.`,
    );
  } catch (error) {
    const code = /^P\d{4}$/.test(String(error?.code)) ? error.code : '';
    console.error(
      `Neon development vehicle check failed at ${stage}: ${failedCheck || 'Connection/request failure'}${code ? ` (${code})` : ''}; ${checks} checks completed.`,
    );
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
    try {
      // UUID emails belong only to this run. Resolve exact IDs before deletion.
      const users = await database.user.findMany({
        where: { email: { in: emails } },
        select: { id: true },
      });
      const ids = users.map((user) => user.id);
      await database.$transaction(async (transaction) => {
        await transaction.vehicle.deleteMany({
          where: { ownership: { userId: { in: ids } } },
        });
        await transaction.user.deleteMany({ where: { id: { in: ids } } });
        await transaction.authRateLimit.deleteMany({
          where: { keyHash: { in: keys } },
        });
      });
      console.log(
        'This run’s synthetic vehicles, ownerships, users, sessions, and counters were removed.',
      );
    } catch {
      console.error(
        `Vehicle fixture cleanup failed for run ${runId}; inspect it before retrying.`,
      );
      process.exitCode = 1;
    }
    await database.$disconnect();
  }
}

main().catch(() => {
  console.error(
    'Neon development verification failed before vehicle tests; no tests were run.',
  );
  process.exitCode = 1;
});
