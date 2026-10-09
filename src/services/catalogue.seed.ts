import { Prisma, VehicleCategoryCode } from '../generated/prisma/client';

type CatalogueVariantSeed = {
  code: string;
  name: string;
};

type CatalogueServiceSeed = {
  code: string;
  name: string;
  slug: string;
  variants?: readonly CatalogueVariantSeed[];
};

export const CATALOGUE_SERVICES: readonly CatalogueServiceSeed[] = [
  {
    code: 'VEHICLE_LICENCE',
    name: 'Vehicle Licence',
    slug: 'vehicle-licence',
  },
  {
    code: 'HACKNEY_PERMIT',
    name: 'Hackney Permit',
    slug: 'hackney-permit',
  },
  {
    code: 'INSURANCE_THIRD_PARTY',
    name: 'Insurance - Third Party',
    slug: 'insurance-third-party',
  },
  {
    code: 'INSURANCE_COMPREHENSIVE',
    name: 'Insurance - Comprehensive',
    slug: 'insurance-comprehensive',
  },
  {
    code: 'ROAD_WORTHINESS_PROOF_OF_OWNERSHIP',
    name: 'Road Worthiness & Proof of Ownership',
    slug: 'road-worthiness-proof-of-ownership',
  },
  {
    code: 'NEW_REGISTRATION',
    name: 'New Registration',
    slug: 'new-registration',
  },
  {
    code: 'C_OF_O_CHANGE_OF_OWNERSHIP',
    name: 'C of O Change of Ownership',
    slug: 'c-of-o-change-of-ownership',
  },
  {
    code: 'NEW_DRIVERS_LICENSE',
    name: 'New Driver’s Licence',
    slug: 'new-drivers-licence',
    variants: [
      { code: 'THREE_YEARS', name: '3 years' },
      { code: 'FIVE_YEARS', name: '5 years' },
    ],
  },
  {
    code: 'DRIVERS_LICENSE_RENEWAL',
    name: 'Renewal of Driver’s Licence',
    slug: 'renewal-of-drivers-licence',
    variants: [
      { code: 'THREE_YEARS', name: '3 years' },
      { code: 'FIVE_YEARS', name: '5 years' },
    ],
  },
  {
    code: 'INTERNATIONAL_DVL',
    name: 'International Driver’s Licence',
    slug: 'international-drivers-licence',
    variants: [{ code: 'ONE_YEAR', name: '1 year' }],
  },
  { code: 'AUTOVIN', name: 'AutoVIN', slug: 'autovin' },
  { code: 'PLATE_REPRINT', name: 'Plate Reprint', slug: 'plate-reprint' },
  { code: 'L_G_PAPERS', name: 'L.G. Papers', slug: 'l-g-papers' },
  {
    code: 'STAGE_CARRIAGE',
    name: 'Stage Carriage',
    slug: 'stage-carriage',
  },
  { code: 'ECMR', name: 'ECMR', slug: 'ecmr' },
  {
    code: 'DOCTORS_REPORT',
    name: 'Doctor’s Report',
    slug: 'doctors-report',
  },
  {
    code: 'EXISTING_C_OF_O',
    name: 'Existing C of O',
    slug: 'existing-c-of-o',
  },
  {
    code: 'TINTED_PERMIT',
    name: 'Tinted Permit',
    slug: 'tinted-permit',
  },
  {
    code: 'POLICE_REPORT_AND_AFFIDAVIT',
    name: 'Police Report and Affidavit',
    slug: 'police-report-and-affidavit',
  },
];

const VEHICLE_CATEGORIES = Object.values(VehicleCategoryCode);

type CatalogueSeedTransaction = Pick<
  Prisma.TransactionClient,
  'service' | 'serviceVariant' | 'serviceVehicleCategory'
>;

type CatalogueSeedDatabase = CatalogueSeedTransaction & {
  $transaction<T>(
    run: (transaction: CatalogueSeedTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
};

export async function seedCatalogue(database: CatalogueSeedDatabase) {
  await database.$transaction(
    async (transaction) => {
      for (const [serviceIndex, item] of CATALOGUE_SERVICES.entries()) {
        const service = await transaction.service.upsert({
          where: { code: item.code },
          create: {
            code: item.code,
            name: item.name,
            slug: item.slug,
            description: null,
            active: true,
            sortOrder: serviceIndex + 1,
          },
          update: {
            name: item.name,
            slug: item.slug,
            active: true,
            sortOrder: serviceIndex + 1,
          },
          select: { id: true },
        });

        for (const [variantIndex, variant] of (item.variants ?? []).entries()) {
          await transaction.serviceVariant.upsert({
            where: {
              serviceId_code: {
                serviceId: service.id,
                code: variant.code,
              },
            },
            create: {
              serviceId: service.id,
              code: variant.code,
              name: variant.name,
              description: null,
              active: true,
              sortOrder: variantIndex + 1,
            },
            update: {
              name: variant.name,
              active: true,
              sortOrder: variantIndex + 1,
            },
            select: { id: true },
          });
        }

        await transaction.serviceVehicleCategory.createMany({
          data: VEHICLE_CATEGORIES.map((categoryCode) => ({
            serviceId: service.id,
            categoryCode,
          })),
          skipDuplicates: true,
        });
      }
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  return {
    services: CATALOGUE_SERVICES.length,
    variants: CATALOGUE_SERVICES.reduce(
      (total, service) => total + (service.variants?.length ?? 0),
      0,
    ),
    categoryLinks: CATALOGUE_SERVICES.length * VEHICLE_CATEGORIES.length,
  };
}
