const path = require('node:path');
const { ConfigService } = require('@nestjs/config');
const { config: loadEnvironment } = require('dotenv');

const backendRoot = path.resolve(__dirname, '..');
loadEnvironment({ path: path.join(backendRoot, '.env'), quiet: true });

async function main() {
  const { validateEnvironment } = require('../dist/config/environment');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { seedCatalogue } = require('../dist/services/catalogue.seed');
  const configuration = validateEnvironment(process.env);
  const database = new PrismaService(new ConfigService(configuration));

  try {
    const seeded = await seedCatalogue(database);
    console.log(
      `Catalogue seed complete: ${seeded.services} services, ${seeded.variants} variants, ${seeded.categoryLinks} category links.`,
    );
  } finally {
    await database.$disconnect();
  }
}

main().catch((error) => {
  const code = /^P\d{4}$/.test(String(error?.code)) ? error.code : '';
  console.error(`Catalogue seed failed${code ? ` (${code})` : ''}.`);
  process.exitCode = 1;
});
