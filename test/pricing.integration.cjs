// Temporary pricing fixtures are restricted to the pinned Neon development branch.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaPg } = require('@prisma/adapter-pg');
const {
  PricingRuleStatus,
  PricingStrategy,
  Prisma,
  PrismaClient,
} = require('../dist/generated/prisma/client');
const { PricingService } = require('../dist/pricing/pricing.service');
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
  const runId = randomUUID();
  const syntheticCode = `PRICING_TEST_${runId.replaceAll('-', '_')}`;
  const syntheticSlug = `pricing-test-${runId}`;
  const fixtureRuleIds = Array.from({ length: 8 }, () => randomUUID());
  let syntheticServiceId;
  let stage = 'setup';
  let checks = 0;
  let failedCheck = '';
  const expect = (condition, label) => {
    if (!condition) failedCheck = label;
    assert.ok(condition, label);
    checks += 1;
  };

  try {
    stage = 'unseeded state';
    expect(
      (await database.pricingRule.count()) === 0,
      'No pricing rules were seeded by the migration',
    );

    const [newLicence, renewal, police, vehicleLicence, comprehensive] =
      await Promise.all(
        [
          'NEW_DRIVERS_LICENSE',
          'DRIVERS_LICENSE_RENEWAL',
          'POLICE_REPORT_AND_AFFIDAVIT',
          'VEHICLE_LICENCE',
          'INSURANCE_COMPREHENSIVE',
        ].map((code) =>
          database.service.findUniqueOrThrow({
            where: { code },
            include: { variants: true },
          }),
        ),
      );
    syntheticServiceId = randomUUID();
    await database.service.create({
      data: {
        id: syntheticServiceId,
        code: syntheticCode,
        name: 'Pricing integration fixture',
        slug: syntheticSlug,
        active: true,
        sortOrder: 9999,
      },
    });
    const variant = (service, code) =>
      service.variants.find((candidate) => candidate.code === code).id;
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
    await database.pricingRule.createMany({
      data: [
        {
          id: fixtureRuleIds[0],
          serviceId: newLicence.id,
          serviceVariantId: variant(newLicence, 'THREE_YEARS'),
          strategy: PricingStrategy.FIXED_BY_VARIANT,
          amount: new Prisma.Decimal('50000.00'),
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          version: 1,
        },
        {
          id: fixtureRuleIds[1],
          serviceId: newLicence.id,
          serviceVariantId: variant(newLicence, 'FIVE_YEARS'),
          strategy: PricingStrategy.FIXED_BY_VARIANT,
          amount: new Prisma.Decimal('55000.00'),
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          version: 1,
        },
        {
          id: fixtureRuleIds[2],
          serviceId: renewal.id,
          serviceVariantId: variant(renewal, 'THREE_YEARS'),
          strategy: PricingStrategy.FIXED_BY_VARIANT,
          amount: new Prisma.Decimal('30000.00'),
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          version: 1,
        },
        {
          id: fixtureRuleIds[3],
          serviceId: renewal.id,
          serviceVariantId: variant(renewal, 'FIVE_YEARS'),
          strategy: PricingStrategy.FIXED_BY_VARIANT,
          amount: new Prisma.Decimal('35000.00'),
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          version: 1,
        },
        {
          id: fixtureRuleIds[4],
          serviceId: police.id,
          strategy: PricingStrategy.FIXED_UNIVERSAL,
          amount: new Prisma.Decimal('6500.00'),
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          version: 1,
        },
        {
          id: fixtureRuleIds[5],
          serviceId: vehicleLicence.id,
          vehicleCategoryCode: 'SUV_PICKUP',
          strategy: PricingStrategy.MANUAL_REVIEW,
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          version: 1,
        },
        {
          id: fixtureRuleIds[6],
          serviceId: comprehensive.id,
          strategy: PricingStrategy.MANUAL_REVIEW,
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          version: 1,
        },
        {
          id: fixtureRuleIds[7],
          serviceId: syntheticServiceId,
          strategy: PricingStrategy.PERCENTAGE_OF_DECLARED_VALUE,
          percentage: new Prisma.Decimal('5.0000'),
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          version: 1,
        },
      ],
    });

    stage = 'resolution';
    const pricing = new PricingService(database);
    const requestedAt = new Date('2026-10-09T12:00:00.000Z');
    const resolve = (serviceId, input = {}) =>
      pricing.resolvePrice({ serviceId, requestedAt, ...input });
    for (const [service, code, expected] of [
      [newLicence, 'THREE_YEARS', '50000.00'],
      [newLicence, 'FIVE_YEARS', '55000.00'],
      [renewal, 'THREE_YEARS', '30000.00'],
      [renewal, 'FIVE_YEARS', '35000.00'],
    ]) {
      const result = await resolve(service.id, {
        serviceVariantId: variant(service, code),
      });
      expect(
        result.resolution === 'AUTO' && result.amount === expected,
        `${service.code}/${code} resolves to the confirmed amount`,
      );
    }
    const policeResult = await resolve(police.id);
    expect(
      policeResult.resolution === 'AUTO' && policeResult.amount === '6500.00',
      'Police Report and Affidavit resolves to ₦6,500',
    );
    const percentageResult = await resolve(syntheticServiceId, {
      declaredVehicleValue: '6000000.00',
    });
    expect(
      percentageResult.resolution === 'AUTO' &&
        percentageResult.amount === '300000.00',
      'Percentage calculation uses decimal arithmetic',
    );
    expect(
      (
        await resolve(vehicleLicence.id, {
          vehicleCategory: 'SUV_PICKUP',
        })
      ).reason === 'MANUAL_REVIEW_REQUIRED',
      'Ambiguous SUV/Pickup Vehicle Licence remains manual review',
    );
    expect(
      (await resolve(comprehensive.id)).reason === 'MANUAL_REVIEW_REQUIRED',
      'Comprehensive Insurance remains manual review',
    );
    console.log(
      `Neon ${branch.name} pricing integration checks passed: ${checks}.`,
    );
  } catch (error) {
    const code = /^P\d{4}$/.test(String(error?.code)) ? error.code : '';
    console.error(
      `Neon development pricing check failed at ${stage}: ${failedCheck || 'Connection/resolution failure'}${code ? ` (${code})` : ''}; ${checks} checks completed.`,
    );
    process.exitCode = 1;
  } finally {
    try {
      await database.$transaction(async (transaction) => {
        await transaction.pricingRule.deleteMany({
          where: { id: { in: fixtureRuleIds } },
        });
        await transaction.service.deleteMany({
          where: {
            OR: [
              ...(syntheticServiceId ? [{ id: syntheticServiceId }] : []),
              { code: syntheticCode },
            ],
          },
        });
      });
      console.log('This run’s temporary pricing fixtures were removed.');
    } catch {
      console.error(
        `Pricing fixture cleanup failed for run ${runId}; inspect it before retrying.`,
      );
      process.exitCode = 1;
    }
    await database.$disconnect();
  }
}

main().catch(() => {
  console.error(
    'Neon development verification failed before pricing tests; no tests were run.',
  );
  process.exitCode = 1;
});
