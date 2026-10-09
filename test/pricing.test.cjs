require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const {
  PricingRuleStatus,
  PricingStrategy,
  Prisma,
} = require('../dist/generated/prisma/client');
const { PricingService } = require('../dist/pricing/pricing.service');

const requestedAt = new Date('2026-10-09T12:00:00.000Z');
const allCategories = [
  'BIKE',
  'SALOON',
  'SUV_PICKUP',
  'TRUCK',
  'BUS_MINI_TRUCK',
];

function fakePricingDatabase() {
  const services = new Map();
  const rules = [];
  return {
    services,
    rules,
    addService(code, { variants = [], categories = allCategories } = {}) {
      const service = {
        id: randomUUID(),
        code,
        active: true,
        variants: variants.map((variantCode) => ({
          id: randomUUID(),
          code: variantCode,
          active: true,
        })),
        categories,
      };
      services.set(service.id, service);
      return service;
    },
    addRule(service, overrides = {}) {
      const rule = {
        id: randomUUID(),
        serviceId: service.id,
        vehicleCategoryCode: null,
        serviceVariantId: null,
        strategy: PricingStrategy.FIXED_UNIVERSAL,
        amount: new Prisma.Decimal('1.00'),
        percentage: null,
        currency: 'NGN',
        status: PricingRuleStatus.ACTIVE,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        version: 1,
        ...overrides,
      };
      if (typeof rule.amount === 'string')
        rule.amount = new Prisma.Decimal(rule.amount);
      if (typeof rule.percentage === 'string')
        rule.percentage = new Prisma.Decimal(rule.percentage);
      rules.push(rule);
      return rule;
    },
    service: {
      async findFirst({ where }) {
        const service = services.get(where.id);
        if (!service?.active) return null;
        return {
          variants: service.variants
            .filter(({ active }) => active)
            .map(({ id }) => ({ id })),
          applicableCategories: service.categories.map((categoryCode) => ({
            categoryCode,
          })),
        };
      },
    },
    pricingRule: {
      async findMany({ where }) {
        return rules
          .filter(
            (rule) =>
              rule.serviceId === where.serviceId &&
              rule.status === where.status &&
              rule.effectiveFrom <= where.effectiveFrom.lte &&
              (rule.effectiveTo === null ||
                rule.effectiveTo > where.OR[1].effectiveTo.gt),
          )
          .map(
            ({
              id,
              vehicleCategoryCode,
              serviceVariantId,
              strategy,
              amount,
              percentage,
              currency,
              version,
            }) => ({
              id,
              vehicleCategoryCode,
              serviceVariantId,
              strategy,
              amount,
              percentage,
              currency,
              version,
            }),
          );
      },
    },
  };
}

async function resolve(pricing, service, input = {}) {
  return pricing.resolvePrice({
    serviceId: service.id,
    requestedAt,
    ...input,
  });
}

test('updated licence variants and Police Report resolve from decimal fixture rules', async () => {
  const database = fakePricingDatabase();
  const pricing = new PricingService(database);
  const newLicence = database.addService('NEW_DRIVERS_LICENSE', {
    variants: ['THREE_YEARS', 'FIVE_YEARS'],
  });
  const renewal = database.addService('DRIVERS_LICENSE_RENEWAL', {
    variants: ['THREE_YEARS', 'FIVE_YEARS'],
  });
  const police = database.addService('POLICE_REPORT_AND_AFFIDAVIT');
  const amounts = [
    [newLicence, 0, '50000.00'],
    [newLicence, 1, '55000.00'],
    [renewal, 0, '30000.00'],
    [renewal, 1, '35000.00'],
  ];
  for (const [service, variantIndex, amount] of amounts) {
    database.addRule(service, {
      strategy: PricingStrategy.FIXED_BY_VARIANT,
      amount,
      serviceVariantId: service.variants[variantIndex].id,
    });
    const result = await resolve(pricing, service, {
      serviceVariantId: service.variants[variantIndex].id,
    });
    assert.equal(result.resolution, 'AUTO');
    assert.equal(result.amount, amount);
    assert.equal(result.currency, 'NGN');
  }
  database.addRule(police, {
    strategy: PricingStrategy.FIXED_UNIVERSAL,
    amount: '6500.00',
  });
  assert.equal((await resolve(pricing, police)).amount, '6500.00');
});

test('effective dates preserve historical fixed category versions with an exclusive end boundary', async () => {
  const database = fakePricingDatabase();
  const pricing = new PricingService(database);
  const registration = database.addService('NEW_REGISTRATION');
  const boundary = new Date('2026-07-01T00:00:00.000Z');
  database.addRule(registration, {
    strategy: PricingStrategy.FIXED_BY_VEHICLE_CATEGORY,
    vehicleCategoryCode: 'SALOON',
    amount: '90000.00',
    effectiveTo: boundary,
    version: 1,
  });
  database.addRule(registration, {
    strategy: PricingStrategy.FIXED_BY_VEHICLE_CATEGORY,
    vehicleCategoryCode: 'SALOON',
    amount: '100000.00',
    effectiveFrom: boundary,
    version: 2,
  });
  const historical = await pricing.resolvePrice({
    serviceId: registration.id,
    vehicleCategory: 'SALOON',
    requestedAt: new Date('2026-06-30T23:59:59.999Z'),
  });
  const current = await pricing.resolvePrice({
    serviceId: registration.id,
    vehicleCategory: 'SALOON',
    requestedAt: boundary,
  });
  assert.equal(historical.amount, '90000.00');
  assert.equal(historical.pricingVersion, 1);
  assert.equal(current.amount, '100000.00');
  assert.equal(current.pricingVersion, 2);
});

test('percentage pricing uses decimal arithmetic and defers unconfirmed rounding', async () => {
  const database = fakePricingDatabase();
  const pricing = new PricingService(database);
  const percentageService = database.addService('PERCENTAGE_TEST_FIXTURE');
  const rule = database.addRule(percentageService, {
    strategy: PricingStrategy.PERCENTAGE_OF_DECLARED_VALUE,
    amount: null,
    percentage: '5.0000',
  });
  const exact = await resolve(pricing, percentageService, {
    declaredVehicleValue: '6000000.00',
  });
  assert.deepEqual(exact, {
    resolution: 'AUTO',
    currency: 'NGN',
    amount: '300000.00',
    pricingRuleId: rule.id,
    pricingVersion: 1,
  });
  assert.equal(
    (await resolve(pricing, percentageService)).reason,
    'DECLARED_VALUE_REQUIRED',
  );
  assert.equal(
    (
      await resolve(pricing, percentageService, {
        declaredVehicleValue: '-1',
      })
    ).reason,
    'INVALID_DECLARED_VALUE',
  );
  assert.equal(
    (
      await resolve(pricing, percentageService, {
        declaredVehicleValue: '100.01',
      })
    ).reason,
    'PERCENTAGE_ROUNDING_UNCONFIRMED',
  );
});

test('ambiguous, blank, manual quote, SUV licence, and comprehensive cases never guess or return zero', async () => {
  const database = fakePricingDatabase();
  const pricing = new PricingService(database);
  const vehicleLicence = database.addService('VEHICLE_LICENCE');
  const comprehensive = database.addService('INSURANCE_COMPREHENSIVE');
  const manualQuote = database.addService('MANUAL_QUOTE_FIXTURE');
  const blank = database.addService('BLANK_PRICE_FIXTURE');
  const pending = database.addService('PENDING_PRICE_FIXTURE');
  const overlap = database.addService('OVERLAP_FIXTURE');

  database.addRule(vehicleLicence, {
    strategy: PricingStrategy.MANUAL_REVIEW,
    amount: null,
    vehicleCategoryCode: 'SUV_PICKUP',
  });
  database.addRule(comprehensive, {
    strategy: PricingStrategy.MANUAL_REVIEW,
    amount: null,
  });
  database.addRule(manualQuote, {
    strategy: PricingStrategy.MANUAL_QUOTE,
    amount: null,
  });
  database.addRule(pending, {
    status: PricingRuleStatus.PENDING_CONFIRMATION,
    amount: '123.00',
  });
  database.addRule(overlap, { amount: '100.00', version: 1 });
  database.addRule(overlap, { amount: '200.00', version: 2 });

  assert.equal(
    (
      await resolve(pricing, vehicleLicence, {
        vehicleCategory: 'SUV_PICKUP',
      })
    ).reason,
    'MANUAL_REVIEW_REQUIRED',
  );
  assert.equal(
    (await resolve(pricing, comprehensive)).reason,
    'MANUAL_REVIEW_REQUIRED',
  );
  assert.equal(
    (await resolve(pricing, manualQuote)).reason,
    'MANUAL_QUOTE_REQUIRED',
  );
  for (const service of [blank, pending]) {
    const result = await resolve(pricing, service);
    assert.equal(result.resolution, 'MANUAL_REVIEW');
    assert.equal(result.reason, 'NO_ACTIVE_RULE');
    assert.equal('amount' in result, false);
  }
  assert.equal(
    (await resolve(pricing, overlap)).reason,
    'AMBIGUOUS_ACTIVE_RULES',
  );
});

test('service, category, and variant prerequisites fail safely before price selection', async () => {
  const database = fakePricingDatabase();
  const pricing = new PricingService(database);
  const variants = database.addService('VARIANT_SERVICE', {
    variants: ['THREE_YEARS'],
  });
  const categoryService = database.addService('CATEGORY_SERVICE', {
    categories: ['SALOON'],
  });
  database.addRule(categoryService, {
    strategy: PricingStrategy.FIXED_BY_VEHICLE_CATEGORY,
    vehicleCategoryCode: 'SALOON',
    amount: '1000.00',
  });

  assert.equal((await resolve(pricing, variants)).reason, 'VARIANT_REQUIRED');
  assert.equal(
    (
      await resolve(pricing, variants, {
        serviceVariantId: randomUUID(),
      })
    ).reason,
    'VARIANT_NOT_FOUND',
  );
  assert.equal(
    (
      await resolve(pricing, categoryService, {
        vehicleCategory: 'TRUCK',
      })
    ).reason,
    'SERVICE_NOT_AVAILABLE_FOR_CATEGORY',
  );
  assert.equal(
    (await resolve(pricing, categoryService)).reason,
    'VEHICLE_CATEGORY_REQUIRED',
  );
  assert.equal(
    (
      await pricing.resolvePrice({
        serviceId: randomUUID(),
        requestedAt,
      })
    ).reason,
    'SERVICE_NOT_FOUND',
  );
  assert.equal(
    (
      await pricing.resolvePrice({
        serviceId: categoryService.id,
        requestedAt: new Date('invalid'),
      })
    ).reason,
    'INVALID_REQUEST_DATE',
  );
});
