require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID, createHash } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-app');
const { validateEnvironment } = require('../dist/config/environment');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { Prisma } = require('../dist/generated/prisma/client');
const { PasswordService } = require('../dist/auth/password.service');
const {
  SessionService,
  sessionTokenHash,
} = require('../dist/auth/session.service');
const { rateLimitKey } = require('../dist/auth/auth-rate-limit.service');
const { registerSchema } = require('../dist/auth/auth.validation');
const { databaseConnectionUrl } = require('../dist/prisma/connection-url');

const sample = {
  firstName: ' Ada ',
  lastName: ' Okafor ',
  email: 'Customer@Example.test ',
  phone: '08031234567',
  password: 'test-only long password phrase',
};

function select(record, selection) {
  if (!record) return null;
  return Object.fromEntries(
    Object.entries(selection)
      .filter(([, included]) => included === true)
      .map(([key]) => [key, record[key]]),
  );
}

function fakeDatabase() {
  const users = new Map();
  const sessions = new Map();
  const buckets = new Map();
  function matchingSessions(where) {
    return [...sessions.values()].filter((session) => {
      const user = users.get(session.userId);
      return (
        (!where.id || session.id === where.id) &&
        (!where.tokenHash || session.tokenHash === where.tokenHash) &&
        (!('revokedAt' in where) || session.revokedAt === where.revokedAt) &&
        (!where.expiresAt || session.expiresAt > where.expiresAt.gt) &&
        (!where.lastSeenAt || session.lastSeenAt > where.lastSeenAt.gt) &&
        (!where.user ||
          (user.status === where.user.status && user.kind === where.user.kind))
      );
    });
  }
  const database = {
    users,
    sessions,
    buckets,
    user: {
      async create({ data, select: selection }) {
        if ([...users.values()].some((user) => user.email === data.email))
          throw new Prisma.PrismaClientKnownRequestError('Duplicate', {
            code: 'P2002',
            clientVersion: 'test',
          });
        const record = {
          id: randomUUID(),
          ...data,
          emailVerifiedAt: null,
          phoneVerifiedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.set(record.id, record);
        return select(record, selection);
      },
      async findUnique({ where, select: selection }) {
        const record = where.id
          ? users.get(where.id)
          : [...users.values()].find((user) => user.email === where.email);
        return select(record, selection);
      },
      async findUniqueOrThrow(args) {
        const record = await this.findUnique(args);
        if (!record) throw new Error('Missing test user');
        return record;
      },
    },
    session: {
      async create({ data }) {
        const record = {
          id: randomUUID(),
          createdAt: new Date(),
          lastSeenAt: new Date(),
          revokedAt: null,
          ...data,
        };
        sessions.set(record.id, record);
        return { id: record.id };
      },
      async findFirst({ where, select: selection }) {
        const session = matchingSessions(where)[0];
        return session
          ? {
              id: session.id,
              user: select(users.get(session.userId), selection.user.select),
            }
          : null;
      },
      async updateMany({ where, data }) {
        const records = matchingSessions(where);
        for (const record of records) Object.assign(record, data);
        return { count: records.length };
      },
    },
    async $transaction(callback) {
      return callback(database);
    },
    async $queryRaw(strings, ...values) {
      if (!strings.join('').includes('INSERT INTO')) return [{ '?column?': 1 }];
      const [key, expiresAt, now] = values;
      const previous = buckets.get(key);
      const bucket =
        !previous || previous.expires_at <= now
          ? { attempts: 1, expires_at: expiresAt }
          : { ...previous, attempts: previous.attempts + 1 };
      buckets.set(key, bucket);
      return [bucket];
    },
    async $executeRaw() {
      return 0;
    },
  };
  return database;
}

// Fast controlled password provider for HTTP boundary tests. The real scrypt
// provider is tested separately below, and the real database suite uses it.
const fakePasswords = {
  async hash(value) {
    return `test-only:${createHash('sha256').update(value).digest('hex')}`;
  },
  async verify(value, encoded) {
    return encoded === (await this.hash(value));
  },
};

async function withApp(overrides, run) {
  const database = fakeDatabase();
  const configuration = validateEnvironment({
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    NODE_ENV: 'test',
    AUTH_RATE_LIMIT_NAMESPACE: `unit:${randomUUID()}`,
    ...overrides,
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(database)
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(configuration))
    .overrideProvider(PasswordService)
    .useValue(fakePasswords)
    .compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.useLogger(false);
  try {
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const send = (route, body, headers = {}) =>
      fetch(`${url}/v1/${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MFS-CSRF': '1',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const register = (input = sample) => send('auth/register', input);
    const login = (
      input = { email: sample.email, password: sample.password },
      headers = {},
    ) => send('auth/login', input, headers);
    await run({ app, database, configuration, url, send, register, login });
  } finally {
    await app.close();
  }
}

function cookieOf(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

test('registration normalizes inputs, captures unverified timestamps, and hides duplicate emails', async () => {
  await withApp({}, async ({ database, register }) => {
    const first = await register();
    const duplicate = await register({
      ...sample,
      password: 'another test-only password',
    });
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await first.json(), await duplicate.json());
    assert.equal(first.headers.get('set-cookie'), null);
    assert.equal(duplicate.headers.get('set-cookie'), null);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(database.users.size, 1);
    const user = [...database.users.values()][0];
    assert.equal(user.email, 'customer@example.test');
    assert.equal(user.phone, '+2348031234567');
    assert.equal(user.firstName, 'Ada');
    assert.equal(user.kind, 'CUSTOMER');
    assert.equal(user.emailVerifiedAt, null);
    assert.equal(user.phoneVerifiedAt, null);
    assert.ok(!Object.hasOwn(user, 'password'));
  });
});

test('registration rejects invalid/overlong inputs and privilege or verification fields', async () => {
  await withApp({}, async ({ database, register }) => {
    for (const invalid of [
      { ...sample, password: 'short' },
      { ...sample, password: 'x'.repeat(129) },
      { ...sample, phone: 'not-a-phone' },
      { ...sample, email: 'broken' },
      { ...sample, kind: 'STAFF' },
      { ...sample, emailVerifiedAt: new Date().toISOString() },
      { ...sample, firstName: '\u200b' },
      { ...sample, status: 'ACTIVE' },
    ]) {
      const response = await register(invalid);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.message, 'Invalid request');
      assert.ok(!JSON.stringify(body).includes(sample.password));
    }
    assert.equal(database.users.size, 0);
  });
  const unicode = {
    ...sample,
    password: '🔐'.repeat(15),
    firstName: 'Ada  Chika',
  };
  assert.equal(registerSchema.parse(unicode).password, unicode.password);
  assert.equal(registerSchema.parse(unicode).firstName, 'Ada Chika');
});

test('login uses a fresh HttpOnly cookie, stores only a digest, and me returns a safe profile', async () => {
  await withApp({}, async ({ database, register, login, url }) => {
    await register();
    const response = await login();
    assert.equal(response.status, 200);
    const serialized = await response.text();
    for (const key of [
      'passwordHash',
      'tokenHash',
      'password',
      'kind',
      'token',
    ])
      assert.ok(!Object.hasOwn(JSON.parse(serialized), key));
    const cookie = cookieOf(response);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.match(response.headers.get('set-cookie'), /Path=\//i);
    const session = [...database.sessions.values()][0];
    assert.equal(session.tokenHash, sessionTokenHash(cookie.split('=')[1]));
    assert.ok(!Object.hasOwn(session, 'token'));
    const profile = await fetch(`${url}/v1/me?userId=another-account`, {
      headers: { Cookie: cookie },
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await profile.json(), JSON.parse(serialized));
    assert.equal((await fetch(`${url}/v1/me`)).status, 401);
  });
});

test('missing users, wrong passwords, disabled users, and staff get the same login failure', async () => {
  await withApp({}, async ({ database, register, login }) => {
    await register();
    const unknown = await login({
      email: 'missing@example.test',
      password: sample.password,
    });
    const wrong = await login({
      email: sample.email,
      password: 'incorrect test-only password',
    });
    const user = [...database.users.values()][0];
    user.status = 'DISABLED';
    const disabled = await login();
    user.status = 'ACTIVE';
    user.kind = 'STAFF';
    const staff = await login();
    const body = await unknown.json();
    for (const response of [wrong, disabled, staff]) {
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), body);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal(database.sessions.size, 0);
  });
});

test('expired, idle, duplicate, malformed, revoked, or disabled-account sessions fail me', async () => {
  await withApp({}, async ({ database, register, login, url, send }) => {
    await register();
    const cookie = cookieOf(await login());
    const session = [...database.sessions.values()][0];
    const get = (value) =>
      fetch(`${url}/v1/me`, { headers: { Cookie: value } });
    assert.equal((await get(`${cookie}; ${cookie}`)).status, 401);
    assert.equal((await get('mfs_session=malformed')).status, 401);
    const expiry = session.expiresAt;
    session.expiresAt = new Date(Date.now() - 1000);
    assert.equal((await get(cookie)).status, 401);
    session.expiresAt = expiry;
    session.lastSeenAt = new Date(Date.now() - 86401000);
    assert.equal((await get(cookie)).status, 401);
    session.lastSeenAt = new Date();
    [...database.users.values()][0].status = 'DISABLED';
    assert.equal((await get(cookie)).status, 401);
    [...database.users.values()][0].status = 'ACTIVE';
    const logout = await send('auth/logout', {}, { Cookie: cookie });
    assert.equal(logout.status, 204);
    assert.ok(session.revokedAt instanceof Date);
    assert.equal((await get(cookie)).status, 401);
    assert.equal(
      (await send('auth/logout', {}, { Cookie: cookie })).status,
      204,
    );
    assert.equal((await send('auth/logout', {})).status, 204);
  });
});

test('re-login rotates the token and revokes the previous cookie', async () => {
  await withApp({}, async ({ register, login, url }) => {
    await register();
    const original = cookieOf(await login());
    const fresh = cookieOf(await login(undefined, { Cookie: original }));
    assert.notEqual(original, fresh);
    assert.equal(
      (await fetch(`${url}/v1/me`, { headers: { Cookie: original } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${url}/v1/me`, { headers: { Cookie: fresh } })).status,
      200,
    );
  });
});

test('CSRF requires JSON, a custom header, and exact allowed origins, including on logout', async () => {
  await withApp({}, async ({ url, send }) => {
    const missingHeader = await fetch(`${url}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
    });
    assert.equal(missingHeader.status, 403);
    assert.equal(
      (
        await send('auth/register', sample, {
          Origin: 'https://untrusted.example',
        })
      ).status,
      403,
    );
    assert.equal(
      (await send('auth/register', sample, { Origin: 'null' })).status,
      403,
    );
    assert.equal(
      (await send('auth/register', sample, { 'Content-Type': 'text/plain' }))
        .status,
      415,
    );
    assert.equal(
      (await send('auth/logout', {}, { Origin: 'https://untrusted.example' }))
        .status,
      403,
    );
    const allowed = await send('auth/register', sample, {
      Origin: 'http://localhost:3000',
    });
    assert.equal(allowed.status, 202);
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      'http://localhost:3000',
    );
    assert.equal(
      allowed.headers.get('access-control-allow-credentials'),
      'true',
    );
    const preflight = await fetch(`${url}/v1/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'X-MFS-CSRF',
      },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });
});

test('account throttles use normalized emails and do not depend on account existence', async () => {
  await withApp(
    { AUTH_LOGIN_ACCOUNT_LIMIT: 1 },
    async ({ register, login }) => {
      await register();
      assert.equal(
        (
          await login({
            email: ' Customer@Example.test ',
            password: 'incorrect',
          })
        ).status,
        401,
      );
      const known = await login();
      assert.equal(known.status, 429);
      assert.ok(Number(known.headers.get('retry-after')) > 0);
      assert.equal(
        (await login({ email: 'missing@example.test', password: 'incorrect' }))
          .status,
        401,
      );
      const missing = await login({
        email: ' MISSING@example.test ',
        password: 'incorrect',
      });
      assert.equal(missing.status, 429);
      assert.deepEqual(await missing.json(), await known.json());
    },
  );
});

test('IP throttles cannot be bypassed with untrusted forwarded headers', async () => {
  await withApp({ AUTH_LOGIN_IP_LIMIT: 1 }, async ({ login }) => {
    assert.equal(
      (
        await login(
          { email: 'one@example.test', password: 'incorrect' },
          { 'X-Forwarded-For': '198.51.100.1' },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await login(
          { email: 'two@example.test', password: 'incorrect' },
          { 'X-Forwarded-For': '198.51.100.2' },
        )
      ).status,
      429,
    );
  });
});

test('registration throttles duplicates and resets expired counter windows', async () => {
  await withApp(
    { AUTH_REGISTER_ACCOUNT_LIMIT: 1 },
    async ({ database, configuration, register }) => {
      assert.equal((await register()).status, 202);
      assert.equal((await register()).status, 429);
      const key = rateLimitKey(
        configuration.AUTH_RATE_LIMIT_NAMESPACE,
        'register:account',
        'customer@example.test',
      );
      database.buckets.get(key).expires_at = new Date(Date.now() - 1000);
      assert.equal((await register()).status, 202);
      assert.equal(database.users.size, 1);
    },
  );
});

test('unexpected storage errors fail closed without returning internal details', async () => {
  await withApp({}, async ({ database, login }) => {
    database.$queryRaw = async () => {
      throw new Error('DO-NOT-EXPOSE: internal database credentials');
    };
    const response = await login();
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(!body.includes('DO-NOT-EXPOSE'));
    assert.ok(!body.includes('credentials'));
  });
});

test('malformed and oversized JSON never echo submitted secrets', async () => {
  await withApp({}, async ({ url }) => {
    const headers = { 'Content-Type': 'application/json', 'X-MFS-CSRF': '1' };
    const malformed = await fetch(`${url}/v1/auth/login`, {
      method: 'POST',
      headers,
      body: 'DO_NOT_ECHO_SUBMITTED_SECRET',
    });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes('DO_NOT_ECHO'));
    const oversized = await fetch(`${url}/v1/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: 'test@example.test',
        password: 'DO_NOT_ECHO'.repeat(2000),
      }),
    });
    assert.equal(oversized.status, 413);
    assert.ok(!(await oversized.text()).includes('DO_NOT_ECHO'));
  });
});

test('secure-mode auth refuses plaintext even with spoofed proxy headers', async () => {
  await withApp(
    {
      SESSION_COOKIE_SECURE: 'true',
      AUTH_ALLOWED_ORIGINS: 'https://mfsservicesng.com',
    },
    async ({ send }) => {
      const response = await send('auth/register', sample, {
        'X-Forwarded-Proto': 'https',
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).message, 'HTTPS is required');
    },
  );
});

test('production sessions use host-only Secure cookies and require HTTPS browser origins', () => {
  const configuration = validateEnvironment({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    AUTH_ALLOWED_ORIGINS: 'https://mfsservicesng.com',
  });
  const service = new SessionService({}, new ConfigService(configuration));
  const captured = [];
  service.setCookie(
    { cookie: (...args) => captured.push(args) },
    'synthetic-test-token',
    new Date(),
  );
  assert.equal(captured[0][0], '__Host-mfs_session');
  assert.equal(captured[0][2].secure, true);
  assert.equal(captured[0][2].httpOnly, true);
  assert.equal(captured[0][2].path, '/');
  assert.ok(!Object.hasOwn(captured[0][2], 'domain'));
  for (const origins of [
    '*',
    'http://mfsservicesng.com',
    'https://mfsservicesng.com/path',
    'https://mfsservicesng.com/',
  ]) {
    assert.throws(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        AUTH_ALLOWED_ORIGINS: origins,
      }),
    );
  }
  assert.throws(() =>
    validateEnvironment({
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      SESSION_TTL_SECONDS: 300,
      SESSION_IDLE_TTL_SECONDS: 600,
    }),
  );
});

test('OpenAPI includes only this slice, marks password write-only, and excludes stored secrets', async () => {
  await withApp({}, async ({ url }) => {
    const document = await (await fetch(`${url}/v1/docs-json`)).json();
    for (const route of [
      '/v1/auth/register',
      '/v1/auth/login',
      '/v1/auth/logout',
      '/v1/me',
    ])
      assert.ok(document.paths[route]);
    assert.equal(
      document.components.schemas.RegisterDto.properties.password.writeOnly,
      true,
    );
    assert.ok(
      !Object.hasOwn(
        document.components.schemas.UserDto.properties,
        'passwordHash',
      ),
    );
    assert.ok(!document.paths['/v1/auth/forgot-password']);
  });
});

test('real scrypt hashes use random salts, verify safely, and reject unknown accounts', async () => {
  const passwords = new PasswordService();
  const hash = await passwords.hash(sample.password);
  assert.match(hash, /^\$scrypt\$131072\$8\$1\$/);
  assert.ok(!hash.includes(sample.password));
  assert.equal(await passwords.verify(sample.password, hash), true);
  assert.equal(await passwords.verify('incorrect', hash), false);
  assert.equal(await passwords.verify(sample.password, null), false);
  assert.equal(
    await passwords.verify(sample.password, 'malformed-hash'),
    false,
  );
  assert.notEqual(await passwords.hash(sample.password), hash);
  const results = await Promise.allSettled([
    passwords.hash('one'),
    passwords.hash('two'),
    passwords.hash('three'),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    2,
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.getStatus(), 429);
});

test('Neon connections explicitly verify TLS certificates without changing local URLs or leaking invalid inputs', () => {
  const neon = new URL(
    databaseConnectionUrl(
      'postgresql://test:test@ep-test-pooler.eu-west-2.aws.neon.tech/test?sslmode=require&channel_binding=require',
    ),
  );
  assert.equal(neon.searchParams.get('sslmode'), 'verify-full');
  assert.equal(neon.searchParams.get('channel_binding'), 'require');
  const local = 'postgresql://test:test@127.0.0.1:5433/test?schema=public';
  assert.equal(databaseConnectionUrl(local), local);
  assert.throws(
    () => databaseConnectionUrl('DO-NOT-ECHO-INVALID-CONNECTION'),
    (error) => error.message === 'Invalid PostgreSQL connection configuration',
  );
});
