const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BACKEND_ROOT,
  verifyNeonDevelopmentTarget,
} = require('./neon-development.cjs');

try {
  const { configuration, branch } = verifyNeonDevelopmentTarget();
  console.log(
    `Verified Neon target: ${branch.name}. ${branch.expiresAt ? 'Branch is temporary; extend it before it expires.' : 'No expiration.'}`,
  );
  const result = spawnSync(
    process.execPath,
    [path.join(BACKEND_ROOT, 'scripts/seed-catalogue.cjs')],
    {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        ...configuration,
        DATABASE_URL: configuration.DATABASE_URL_UNPOOLED,
      },
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const code = `${result.stdout ?? ''}${result.stderr ?? ''}`.match(
      /\bP\d{4}\b/,
    )?.[0];
    throw new Error(
      `Development catalogue seed failed${code ? ` (${code})` : ''}; no automatic recovery was attempted.`,
    );
  }
  console.log('Idempotent catalogue seed applied successfully to development.');
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : 'Development catalogue seed failed.',
  );
  process.exitCode = 1;
}
