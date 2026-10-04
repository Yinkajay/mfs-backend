const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse } = require('dotenv');

const PROJECT_ID = 'nameless-feather-21505568';
const BRANCH_ID = 'br-restless-fog-b4plxcc9';
const BACKEND_ROOT = path.resolve(__dirname, '..');

function fail(message) {
  throw new Error(message);
}

function neonGet(apiPath) {
  const args = [
    'api',
    apiPath,
    '--method',
    'GET',
    '--context-file',
    path.join(BACKEND_ROOT, '.neon'),
    '--output',
    'json',
  ];
  let command = 'neon';
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['neon.cmd'], { encoding: 'utf8' });
    const shim = where.stdout?.trim().split(/\r?\n/)[0];
    if (where.status !== 0 || !shim)
      fail(
        'Neon CLI is unavailable. Install it and run neon auth in this backend.',
      );
    const cli = path.join(
      path.dirname(shim),
      'node_modules',
      'neon',
      'dist',
      'cli.js',
    );
    if (!fs.existsSync(cli))
      fail('Cannot locate the installed Neon CLI module.');
    command = process.execPath;
    args.unshift(cli);
  }
  const result = spawnSync(command, args, {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    timeout: 45000,
    maxBuffer: 2 * 1024 * 1024,
  });
  // Never echo CLI output, errors, tokens, or database credentials.
  if (result.status !== 0)
    fail(
      'Neon development verification failed. Check CLI authentication and project access; no migration was run.',
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('Neon returned an unexpected response; no migration was run.');
  }
}

function verifyNeonDevelopmentTarget() {
  if (process.versions.node.split('.')[0] !== '24')
    fail('Use Node.js 24 for this backend.');
  let configuration;
  let context;
  try {
    configuration = parse(
      fs.readFileSync(path.join(BACKEND_ROOT, '.env'), 'utf8'),
    );
    context = JSON.parse(
      fs.readFileSync(path.join(BACKEND_ROOT, '.neon'), 'utf8'),
    );
  } catch {
    fail('The backend needs its existing ignored .env and .neon files.');
  }
  for (const file of ['.env', '.neon']) {
    if (
      spawnSync('git', ['check-ignore', '-q', file], { cwd: BACKEND_ROOT })
        .status !== 0
    )
      fail(`${file} must be Git-ignored before continuing.`);
    if (
      spawnSync('git', ['ls-files', '--error-unmatch', file], {
        cwd: BACKEND_ROOT,
        stdio: 'pipe',
      }).status === 0
    )
      fail(`${file} must not be tracked by Git.`);
  }
  if (
    context.projectId !== PROJECT_ID ||
    !['development', BRANCH_ID].includes(context.branch ?? context.branchId) ||
    configuration.NEON_BRANCH !== 'development'
  )
    fail('Refusing a target other than the pinned MFS development branch.');
  for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    if (process.env[key] && process.env[key] !== configuration[key])
      fail(`Refusing a conflicting runtime ${key} override.`);
  }
  if (
    process.env.NODE_ENV === 'production' ||
    configuration.NODE_ENV === 'production'
  )
    fail('This helper is development-only.');
  const { branch } = neonGet(`/projects/${PROJECT_ID}/branches/${BRANCH_ID}`);
  if (!branch || branch.id !== BRANCH_ID || branch.name !== 'development')
    fail('Neon did not confirm the expected development branch.');
  if (branch.expires_at && Date.parse(branch.expires_at) <= Date.now())
    fail('Development has expired. Extend it before running this command.');
  const { endpoints } = neonGet(`/projects/${PROJECT_ID}/endpoints`);
  const hosts = (endpoints ?? [])
    .filter(
      (endpoint) =>
        endpoint.branch_id === BRANCH_ID && endpoint.type === 'read_write',
    )
    .map((endpoint) => endpoint.host);
  let pooled;
  let direct;
  try {
    pooled = new URL(configuration.DATABASE_URL);
    direct = new URL(configuration.DATABASE_URL_UNPOOLED);
  } catch {
    fail('Both Neon Postgres connection variables must be present and valid.');
  }
  const safeUrl = (url) =>
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['require', 'verify-ca', 'verify-full'].includes(
      url.searchParams.get('sslmode'),
    ) &&
    (url.searchParams.get('schema') ?? 'public') === 'public';
  if (
    !safeUrl(pooled) ||
    !safeUrl(direct) ||
    !hosts.includes(direct.hostname) ||
    !hosts.includes(pooled.hostname.replace('-pooler.', '.')) ||
    pooled.pathname !== direct.pathname ||
    pooled.username !== direct.username ||
    pooled.password !== direct.password
  )
    fail(
      'Connection variables do not both match the verified development compute.',
    );
  return {
    configuration,
    branch: {
      id: branch.id,
      name: branch.name,
      expiresAt: branch.expires_at ?? null,
    },
  };
}

module.exports = { BACKEND_ROOT, verifyNeonDevelopmentTarget };
