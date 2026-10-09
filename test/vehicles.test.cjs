require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { UnauthorizedException } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-app');
const { validateEnvironment } = require('../dist/config/environment');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { Prisma } = require('../dist/generated/prisma/client');
const { CustomerSessionGuard } = require('../dist/auth/customer-session.guard');
const { PUBLIC_VEHICLE_SELECT } = require('../dist/vehicles/vehicles.dto');

const alice = randomUUID();
const bob = randomUUID();
const categories = ['BIKE', 'SALOON', 'SUV_PICKUP', 'TRUCK', 'BUS_MINI_TRUCK'];
const optionalFields = [
  'name',
  'registrationNumber',
  'registrationNumberNormalized',
  'make',
  'model',
  'year',
  'colour',
  'chassisNumber',
  'engineNumber',
  'engineCapacity',
  'usageType',
  'stateOfRegistration',
];

function fakeDatabase() {
  const records = new Map();
  const project = (record, select) =>
    Object.fromEntries(
      Object.keys(select)
        .filter((key) => select[key])
        .map((key) => [key, record[key]]),
    );
  const database = {
    records,
    unavailable: false,
    async $queryRaw() {
      return [{ attempts: 1, expires_at: new Date(Date.now() + 60000) }];
    },
    async $executeRaw() {
      return 0;
    },
    async $transaction(run) {
      return run(database);
    },
    vehicle: {
      matching(where) {
        assert.ok(
          where.ownership?.userId,
          'Every query/write must contain ownership',
        );
        if (database.unavailable)
          throw new Error('private driver details and credentials');
        return [...records.values()].filter(
          (record) =>
            record.owner === where.ownership.userId &&
            (!where.id || record.id === where.id) &&
            (where.registrationNumberNormalized === undefined ||
              record.registrationNumberNormalized ===
                where.registrationNumberNormalized),
        );
      },
      async create({ data, select }) {
        if (database.unavailable)
          throw new Error('private driver details and credentials');
        const record = {
          id: randomUUID(),
          ...Object.fromEntries(optionalFields.map((key) => [key, null])),
          ...data,
          owner: data.ownership.create.user.connect.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        records.set(record.id, record);
        return project(record, select);
      },
      async findFirst({ where, select }) {
        const record = this.matching(where)[0];
        return record ? project(record, select) : null;
      },
      async findMany({ where, orderBy, skip, take, select }) {
        assert.deepEqual(orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
        return this.matching(where)
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
          .slice(skip, skip + take)
          .map((record) => project(record, select));
      },
      async count({ where }) {
        return this.matching(where).length;
      },
      async update({ where, data, select }) {
        const record = this.matching(where)[0];
        if (!record)
          throw new Prisma.PrismaClientKnownRequestError('Missing', {
            code: 'P2025',
            clientVersion: 'test',
          });
        Object.assign(record, data, { updatedAt: new Date() });
        return project(record, select);
      },
      async delete({ where, select }) {
        const record = this.matching(where)[0];
        if (!record)
          throw new Prisma.PrismaClientKnownRequestError('Missing', {
            code: 'P2025',
            clientVersion: 'test',
          });
        records.delete(record.id);
        return project(record, select);
      },
    },
  };
  return database;
}

async function withApp(run) {
  const database = fakeDatabase();
  const config = validateEnvironment({
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    NODE_ENV: 'test',
    AUTH_RATE_LIMIT_NAMESPACE: `vehicles-unit:${randomUUID()}`,
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(database)
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(config))
    .overrideGuard(CustomerSessionGuard)
    .useValue({
      canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const userId = { alice, bob }[request.headers.cookie];
        if (!userId) throw new UnauthorizedException('Authentication required');
        request.customerSession = { user: { id: userId } };
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.useLogger(false);
  try {
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const request = (method, route = '', body, owner = 'alice', headers = {}) =>
      fetch(`${url}/v1/vehicles${route}`, {
        method,
        headers: {
          ...(owner ? { Cookie: owner } : {}),
          ...(method === 'GET' ? {} : { 'X-MFS-CSRF': '1' }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await run({ database, request, url });
  } finally {
    await app.close();
  }
}

test('five categories, incomplete vehicles, duplicate plates and raw/search values are supported', async () =>
  withApp(async ({ request }) => {
    for (const category of categories) {
      const created = await request('POST', '', {
        category,
        registrationNumber: '  abC - 123 la  ',
        make: ' Toyota ',
        engineCapacity: '2.5 L',
        usageType: 'PRIVATE',
      });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get('cache-control'), 'no-store');
      const vehicle = await created.json();
      assert.equal(vehicle.category, category);
      assert.equal(vehicle.registrationNumber, '  abC - 123 la  ');
      assert.equal(vehicle.registrationNumberNormalized, 'ABC-123LA');
      assert.equal(vehicle.make, 'Toyota');
      assert.equal(vehicle.engineCapacity, '2.5 L');
      assert.deepEqual(
        Object.keys(vehicle).sort(),
        Object.keys(PUBLIC_VEHICLE_SELECT).sort(),
      );
    }
    assert.equal(
      (
        await request(
          'POST',
          '',
          { category: 'SALOON', registrationNumber: 'ABC-123LA' },
          'bob',
        )
      ).status,
      201,
    );
    const partial = await request('POST', '', { category: 'BIKE' });
    assert.equal(partial.status, 201);
    assert.equal((await partial.json()).registrationNumber, null);
  }));

test('read, update and delete mask other customers’ vehicles with the same 404 as missing records', async () =>
  withApp(async ({ database, request }) => {
    const vehicle = await (
      await request('POST', '', { category: 'SUV_PICKUP', colour: 'Blue' })
    ).json();
    const missing = randomUUID();
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const body = method === 'PATCH' ? { colour: 'Red' } : undefined;
      const foreign = await request(method, `/${vehicle.id}`, body, 'bob');
      const absent = await request(method, `/${missing}`, body, 'bob');
      assert.equal(foreign.status, 404);
      assert.equal(absent.status, 404);
      assert.deepEqual(await foreign.json(), await absent.json());
    }
    assert.equal(database.records.get(vehicle.id).colour, 'Blue');
    const bobList = await (await request('GET', '', undefined, 'bob')).json();
    assert.deepEqual(bobList, { items: [], total: 0, limit: 20, offset: 0 });
    assert.equal((await request('GET', `/${vehicle.id}`)).status, 200);
    assert.equal((await request('DELETE', `/${vehicle.id}`)).status, 204);
    assert.equal((await request('GET', `/${vehicle.id}`)).status, 404);
  }));

test('listing is owner-scoped, paginated, bounded and searchable by normalized registration', async () =>
  withApp(async ({ request }) => {
    for (const registrationNumber of ['abc 123', 'xyz-987', 'other'])
      await request('POST', '', { category: 'SALOON', registrationNumber });
    await request(
      'POST',
      '',
      { category: 'SALOON', registrationNumber: 'ABC123' },
      'bob',
    );
    const paged = await (await request('GET', '?limit=1&offset=1')).json();
    assert.equal(paged.items.length, 1);
    assert.equal(paged.total, 3);
    assert.equal(paged.limit, 1);
    assert.equal(paged.offset, 1);
    const filtered = await (
      await request('GET', '?registrationNumber=aBc%20%20123')
    ).json();
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].registrationNumberNormalized, 'ABC123');
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?offset=-1',
      '?offset=100001',
      '?limit=1.5',
      '?limit=1&limit=2',
      '?userId=anything',
    ])
      assert.equal((await request('GET', query)).status, 400);
  }));

test('partial updates preserve omitted fields and clear paired registration values atomically', async () =>
  withApp(async ({ request }) => {
    const vehicle = await (
      await request('POST', '', {
        category: 'BUS_MINI_TRUCK',
        registrationNumber: 'abc 123',
        make: 'Toyota',
        year: 2020,
      })
    ).json();
    const changed = await (
      await request('PATCH', `/${vehicle.id}`, {
        registrationNumber: ' xyZ 456 ',
        colour: ' Red ',
      })
    ).json();
    assert.equal(changed.registrationNumber, ' xyZ 456 ');
    assert.equal(changed.registrationNumberNormalized, 'XYZ456');
    assert.equal(changed.make, 'Toyota');
    assert.equal(changed.year, 2020);
    assert.equal(changed.colour, 'Red');
    const cleared = await (
      await request('PATCH', `/${vehicle.id}`, {
        registrationNumber: null,
        year: null,
      })
    ).json();
    assert.equal(cleared.registrationNumber, null);
    assert.equal(cleared.registrationNumberNormalized, null);
    assert.equal(cleared.year, null);
    assert.equal(cleared.make, 'Toyota');
  }));

test('vehicle names are optional, normalized, bounded, owner-scoped, and clearable', async () =>
  withApp(async ({ request }) => {
    const unnamed = await (
      await request('POST', '', { category: 'BIKE' })
    ).json();
    assert.equal(unnamed.name, null);
    const named = await request('POST', '', {
      category: 'SALOON',
      name: '  Family cafe\u0301 car  ',
      make: 'Toyota',
    });
    assert.equal(named.status, 201);
    const vehicle = await named.json();
    assert.equal(vehicle.name, 'Family café car');
    assert.equal(
      (await (await request('GET', `/${vehicle.id}`)).json()).name,
      vehicle.name,
    );
    assert.ok(
      (await (await request('GET')).json()).items.some(
        (item) => item.id === vehicle.id && item.name === vehicle.name,
      ),
    );
    const foreign = await request(
      'PATCH',
      `/${vehicle.id}`,
      { name: 'Other customer name' },
      'bob',
    );
    assert.equal(foreign.status, 404);
    assert.equal(
      (await (await request('GET', `/${vehicle.id}`)).json()).name,
      vehicle.name,
    );
    const renamed = await request('PATCH', `/${vehicle.id}`, {
      name: '  Work car  ',
    });
    assert.equal(renamed.status, 200);
    const updated = await renamed.json();
    assert.equal(updated.name, 'Work car');
    assert.equal(updated.make, 'Toyota');
    const untouched = await (
      await request('PATCH', `/${vehicle.id}`, { colour: 'Blue' })
    ).json();
    assert.equal(untouched.name, 'Work car');
    assert.equal(
      (await (await request('PATCH', `/${vehicle.id}`, { name: null })).json())
        .name,
      null,
    );
    for (const name of [
      '   ',
      'x'.repeat(81),
      '\u0344'.repeat(80),
      'bad\u0000name',
      'bad\u200bname',
      123,
    ]) {
      assert.equal(
        (await request('POST', '', { category: 'BIKE', name })).status,
        400,
      );
      assert.equal(
        (await request('PATCH', `/${vehicle.id}`, { name })).status,
        400,
      );
    }
    assert.equal(
      (await request('PATCH', `/${vehicle.id}`, { name: 'x'.repeat(80) }))
        .status,
      200,
    );
    assert.equal(
      (await request('POST', '', { category: 'BIKE', name: 'Work car' }))
        .status,
      201,
    );
    assert.equal(
      (await request('POST', '', { category: 'BIKE', name: 'Work car' }, 'bob'))
        .status,
      201,
    );
  }));

test('validation blocks mass assignment, invalid UUIDs, unsupported categories and malformed fields', async () =>
  withApp(async ({ request }) => {
    for (const invalid of [
      {},
      { category: 'CAR' },
      { category: null },
      { category: 'SALOON', ownerId: bob },
      { category: 'SALOON', ownership: { userId: bob } },
      { category: 'SALOON', registrationNumberNormalized: 'fake' },
      { category: 'SALOON', registrationNumber: '   ' },
      { category: 'SALOON', make: ' ' },
      { category: 'SALOON', year: '2020' },
      { category: 'SALOON', year: 2020.5 },
      { category: 'SALOON', year: 999 },
      { category: 'SALOON', chassisNumber: 'x'.repeat(81) },
      { category: 'SALOON', colour: '\u0000' },
    ])
      assert.equal((await request('POST', '', invalid)).status, 400);
    const vehicle = await (
      await request('POST', '', { category: 'SALOON' })
    ).json();
    for (const invalid of [
      {},
      { category: null },
      { userId: bob },
      { id: randomUUID() },
    ])
      assert.equal(
        (await request('PATCH', `/${vehicle.id}`, invalid)).status,
        400,
      );
    for (const method of ['GET', 'PATCH', 'DELETE'])
      assert.equal(
        (
          await request(
            method,
            '/invalid-id',
            method === 'PATCH' ? { colour: 'Red' } : undefined,
          )
        ).status,
        400,
      );
  }));

test('all operations require a customer session and every mutation requires CSRF protection', async () =>
  withApp(async ({ request }) => {
    const id = randomUUID();
    for (const [method, route, body] of [
      ['GET', '', undefined],
      ['GET', `/${id}`, undefined],
      ['POST', '', { category: 'SALOON' }],
      ['PATCH', `/${id}`, { colour: 'Red' }],
      ['DELETE', `/${id}`, undefined],
    ]) {
      assert.equal((await request(method, route, body, '')).status, 401);
      assert.equal((await request(method, route, body, 'staff')).status, 401);
      if (method !== 'GET')
        assert.equal(
          (await request(method, route, body, 'alice', { 'X-MFS-CSRF': '' }))
            .status,
          403,
        );
    }
    assert.equal(
      (
        await request('POST', '', { category: 'SALOON' }, 'alice', {
          'Content-Type': 'text/plain',
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await request('PATCH', `/${id}`, { colour: 'Red' }, 'alice', {
          'Content-Type': 'text/plain',
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await request('GET', '', undefined, 'alice', {
          Origin: 'https://not-mfs.example',
        })
      ).status,
      403,
    );
    const allowed = await request('GET', '', undefined, 'alice', {
      Origin: 'http://localhost:3000',
    });
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      'http://localhost:3000',
    );
    assert.equal(
      allowed.headers.get('access-control-allow-credentials'),
      'true',
    );
  }));

test('storage failures return a sanitized no-store error and Swagger documents the full contract', async () =>
  withApp(async ({ database, request, url }) => {
    database.unavailable = true;
    const response = await request('GET');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      statusCode: 503,
      message: 'Vehicle services are temporarily unavailable',
    });
    const document = await (await fetch(`${url}/v1/docs-json`)).json();
    assert.ok(document.paths['/v1/vehicles'].get);
    assert.ok(document.paths['/v1/vehicles'].post);
    for (const method of ['get', 'patch', 'delete'])
      assert.ok(document.paths['/v1/vehicles/{id}'][method]);
    assert.deepEqual(
      document.components.schemas.VehicleCategoryCode.enum,
      categories,
    );
    assert.deepEqual(document.components.schemas.CreateVehicleDto.required, [
      'category',
    ]);
    assert.equal(
      document.components.schemas.CreateVehicleDto.properties.name.maxLength,
      80,
    );
    assert.equal(
      document.components.schemas.CreateVehicleDto.properties.name.nullable,
      true,
    );
    assert.ok(
      document.paths['/v1/vehicles'].post.security.some(
        (scheme) => scheme.customerSession,
      ),
    );
    assert.ok(
      !document.paths['/v1/vehicles'].get.parameters.some(
        (parameter) => parameter.name === 'X-MFS-CSRF',
      ),
    );
    const preflight = await fetch(`${url}/v1/vehicles/${randomUUID()}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'Content-Type,X-MFS-CSRF',
      },
    });
    assert.ok(
      preflight.headers.get('access-control-allow-methods').includes('PATCH'),
    );
    assert.ok(
      preflight.headers.get('access-control-allow-methods').includes('DELETE'),
    );
  }));
