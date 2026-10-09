require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-app');
const { validateEnvironment } = require('../dist/config/environment');
const { PrismaService } = require('../dist/prisma/prisma.service');
const {
  CATALOGUE_SERVICES,
  seedCatalogue,
} = require('../dist/services/catalogue.seed');

const categoryNames = {
  BIKE: 'Bike',
  SALOON: 'Saloon',
  SUV_PICKUP: 'SUV / Pickup',
  TRUCK: 'Truck',
  BUS_MINI_TRUCK: 'Bus / Mini Truck',
};

function fakeDatabase() {
  const services = new Map();
  const variants = new Map();
  const categoryLinks = new Set();
  const database = {
    services,
    variants,
    categoryLinks,
    unavailable: false,
    async $transaction(run) {
      return run(database);
    },
    service: {
      async upsert({ where, create, update }) {
        const current = services.get(where.code);
        if (current) {
          Object.assign(current, update, { updatedAt: new Date() });
          return { id: current.id };
        }
        const record = {
          id: randomUUID(),
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        services.set(record.code, record);
        return { id: record.id };
      },
      async findMany(query) {
        if (database.unavailable)
          throw new Error('database host and private credentials');
        assert.deepEqual(query.where, { active: true });
        return [...services.values()]
          .filter((service) => service.active)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
          .map(materialize);
      },
      async findFirst(query) {
        if (database.unavailable)
          throw new Error('database host and private credentials');
        const service = [...services.values()].find(
          (candidate) =>
            candidate.slug === query.where.slug && candidate.active,
        );
        return service ? materialize(service) : null;
      },
    },
    serviceVariant: {
      async upsert({ where, create, update }) {
        const key = `${where.serviceId_code.serviceId}:${where.serviceId_code.code}`;
        const current = variants.get(key);
        if (current) {
          Object.assign(current, update, { updatedAt: new Date() });
          return { id: current.id };
        }
        const record = {
          id: randomUUID(),
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        variants.set(key, record);
        return { id: record.id };
      },
    },
    serviceVehicleCategory: {
      async createMany({ data, skipDuplicates }) {
        assert.equal(skipDuplicates, true);
        const before = categoryLinks.size;
        for (const link of data)
          categoryLinks.add(`${link.serviceId}:${link.categoryCode}`);
        return { count: categoryLinks.size - before };
      },
    },
  };

  function materialize(service) {
    return {
      code: service.code,
      name: service.name,
      slug: service.slug,
      description: service.description,
      variants: [...variants.values()]
        .filter((variant) => variant.serviceId === service.id && variant.active)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .map(({ code, name, description }) => ({ code, name, description })),
      applicableCategories: [...categoryLinks]
        .filter((key) => key.startsWith(`${service.id}:`))
        .map((key) => key.slice(service.id.length + 1))
        .sort()
        .map((code) => ({ category: { code, name: categoryNames[code] } })),
    };
  }

  return database;
}

async function withApp(database, run) {
  const config = validateEnvironment({
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    NODE_ENV: 'test',
    SWAGGER_ENABLED: 'true',
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(database)
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(config))
    .compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.useLogger(false);
  try {
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}

test('the idempotent seed creates 19 source-named services, five variants, and every category link', async () => {
  const database = fakeDatabase();
  const first = await seedCatalogue(database);
  const second = await seedCatalogue(database);
  assert.deepEqual(first, { services: 19, variants: 5, categoryLinks: 95 });
  assert.deepEqual(second, first);
  assert.equal(database.services.size, 19);
  assert.equal(database.variants.size, 5);
  assert.equal(database.categoryLinks.size, 95);
  assert.deepEqual(
    [...database.services.values()].map(({ name }) => name),
    CATALOGUE_SERVICES.map(({ name }) => name),
  );
  assert.ok(
    database.services.has('POLICE_REPORT_AND_AFFIDAVIT'),
    'The confirmed nineteenth service is seeded',
  );
  for (const service of database.services.values()) {
    assert.equal(service.active, true);
    assert.equal(service.description, null);
  }
});

test('anonymous callers can list active services with variants and all five vehicle categories', async () => {
  const database = fakeDatabase();
  await seedCatalogue(database);
  await withApp(database, async (url) => {
    const response = await fetch(`${url}/v1/services`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items.length, 19);
    assert.deepEqual(
      body.items.map(({ name }) => name),
      CATALOGUE_SERVICES.map(({ name }) => name),
    );
    for (const service of body.items) {
      assert.equal(service.vehicleCategories.length, 5);
      assert.deepEqual(Object.keys(service).sort(), [
        'code',
        'description',
        'name',
        'slug',
        'variants',
        'vehicleCategories',
      ]);
      assert.ok(!('price' in service) && !('pricingStrategy' in service));
    }
    assert.deepEqual(
      body.items.find(({ code }) => code === 'NEW_DRIVERS_LICENSE').variants,
      [
        { code: 'THREE_YEARS', name: '3 years', description: null },
        { code: 'FIVE_YEARS', name: '5 years', description: null },
      ],
    );
    assert.deepEqual(
      body.items.find(({ code }) => code === 'DRIVERS_LICENSE_RENEWAL')
        .variants,
      [
        { code: 'THREE_YEARS', name: '3 years', description: null },
        { code: 'FIVE_YEARS', name: '5 years', description: null },
      ],
    );
    assert.deepEqual(
      body.items.find(({ code }) => code === 'INTERNATIONAL_DVL').variants,
      [{ code: 'ONE_YEAR', name: '1 year', description: null }],
    );
  });
});

test('slug lookup returns only active services and active variants', async () => {
  const database = fakeDatabase();
  await seedCatalogue(database);
  const newLicence = database.services.get('NEW_DRIVERS_LICENSE');
  const hiddenVariant = [...database.variants.values()].find(
    (variant) =>
      variant.serviceId === newLicence.id && variant.code === 'FIVE_YEARS',
  );
  hiddenVariant.active = false;
  await withApp(database, async (url) => {
    const response = await fetch(`${url}/v1/services/new-drivers-licence`);
    assert.equal(response.status, 200);
    const service = await response.json();
    assert.equal(service.name, 'New Driver’s Licence');
    assert.deepEqual(
      service.variants.map(({ code }) => code),
      ['THREE_YEARS'],
    );

    newLicence.active = false;
    const inactive = await fetch(`${url}/v1/services/new-drivers-licence`);
    const missing = await fetch(`${url}/v1/services/not-in-the-catalogue`);
    assert.equal(inactive.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await inactive.json(), await missing.json());
  });
});

test('storage failures are sanitized and OpenAPI documents both public routes', async () => {
  const database = fakeDatabase();
  await seedCatalogue(database);
  await withApp(database, async (url) => {
    const document = await (await fetch(`${url}/v1/docs-json`)).json();
    assert.ok(document.paths['/v1/services'].get);
    assert.ok(document.paths['/v1/services/{slug}'].get);
    assert.equal(document.paths['/v1/services'].get.security, undefined);

    database.unavailable = true;
    const response = await fetch(`${url}/v1/services`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const serialized = await response.text();
    assert.match(serialized, /temporarily unavailable/);
    assert.ok(!serialized.includes('private credentials'));
  });
});
