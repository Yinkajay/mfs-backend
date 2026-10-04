// Opt-in real database suite. Only the verified MFS Neon development compute
// is allowed; fixtures and counter keys are unique to this run and cleaned up.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { ConfigService } = require('@nestjs/config');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client');
const { validateEnvironment } = require('../dist/config/environment');
const {
  AuthRateLimitService,
  rateLimitKey,
} = require('../dist/auth/auth-rate-limit.service');
const { sessionTokenHash } = require('../dist/auth/session.service');
const { databaseConnectionUrl } = require('../dist/prisma/connection-url');
const {
  BACKEND_ROOT,
  verifyNeonDevelopmentTarget,
} = require('../scripts/neon-development.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { configuration, branch } = verifyNeonDevelopmentTarget();
  const runId = randomUUID();
  const namespace = `integration:${runId}`;
  const firstEmail = `mfs-auth-${runId}@example.test`;
  const secondEmail = `mfs-auth-second-${runId}@example.test`;
  const missingEmail = `mfs-auth-missing-${runId}@example.test`;
  const atomicIdentity = `atomic:${runId}`;
  const accountEmails = [firstEmail, secondEmail, missingEmail];
  const keys = [rateLimitKey(namespace, 'integration:atomic', atomicIdentity)];
  for (const scope of ['login:ip', 'register:ip', 'session:ip']) {
    for (const address of ['127.0.0.1', '::ffff:127.0.0.1'])
      keys.push(rateLimitKey(namespace, scope, address));
  }
  for (const scope of ['login:account', 'register:account']) {
    for (const email of accountEmails)
      keys.push(rateLimitKey(namespace, scope, email));
  }
  const database = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseConnectionUrl(configuration.DATABASE_URL),
      connectionTimeoutMillis: 10000,
      query_timeout: 10000,
    }),
  });
  let child;
  let origin;
  let stage = 'setup';
  let checks = 0;
  let failedCheck = '';
  let cleanupSucceeded = false;
  const expect = (condition, label) => {
    if (!condition) failedCheck = label;
    assert.ok(condition, label);
    checks += 1;
  };

  async function stopApi() {
    if (!child) return;
    const current = child;
    child = undefined;
    if (current.exitCode === null) {
      const exited = once(current, 'exit');
      current.kill();
      await Promise.race([exited, sleep(3000)]);
    }
  }

  async function startApi() {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['dist/main.js'], {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        ...configuration,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        SESSION_COOKIE_SECURE: 'false',
        AUTH_ALLOWED_ORIGINS: 'http://localhost:3000',
        AUTH_RATE_LIMIT_NAMESPACE: namespace,
        AUTH_LOGIN_IP_LIMIT: '1000',
        AUTH_LOGIN_ACCOUNT_LIMIT: '20',
        SESSION_TTL_SECONDS: '604800',
        SESSION_IDLE_TTL_SECONDS: '86400',
        SWAGGER_ENABLED: 'true',
        AUTH_REGISTER_IP_LIMIT: '100',
        AUTH_REGISTER_ACCOUNT_LIMIT: '3',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Verification API exited');
      try {
        const response = await fetch(`${origin}/v1/health/ready`, {
          signal: AbortSignal.timeout(6000),
        });
        if (response.status === 200) return;
      } catch {
        /* Retry a cold Neon compute; never echo driver errors. */
      }
      await sleep(500);
    }
    throw new Error('Database readiness timed out');
  }

  const send = (route, body, cookie) =>
    fetch(`${origin}/v1/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MFS-CSRF': '1',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  const login = (
    email,
    cookie,
    password = 'integration-only unique password phrase',
  ) => send('auth/login', { email, password }, cookie);
  const profile = (cookie, suffix = '') =>
    fetch(`${origin}/v1/me${suffix}`, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(15000),
    });
  const cookieOf = (response) => {
    const cookie = response.headers.get('set-cookie');
    expect(Boolean(cookie), 'Login returned a session cookie');
    return cookie.split(';')[0];
  };

  try {
    stage = 'readiness';
    await startApi();
    expect(
      (await fetch(`${origin}/v1/health`)).status === 200,
      'Liveness passes',
    );
    expect((await profile()).status === 401, 'Anonymous profile denied');
    stage = 'registration';
    const registrationInput = {
      firstName: ' Integration ',
      lastName: ' Customer ',
      email: ` ${firstEmail.toUpperCase()} `,
      phone: '08031234567',
      password: 'integration-only unique password phrase',
    };
    const registration = await send('auth/register', registrationInput);
    const duplicate = await send('auth/register', {
      ...registrationInput,
      password: 'different integration-only password phrase',
    });
    expect(
      registration.status === 202 && duplicate.status === 202,
      'New and duplicate registrations return 202',
    );
    expect(
      JSON.stringify(await registration.json()) ===
        JSON.stringify(await duplicate.json()),
      'Registration does not reveal email existence',
    );
    expect(
      !registration.headers.get('set-cookie') &&
        !duplicate.headers.get('set-cookie'),
      'Registration never auto-authenticates',
    );
    const first = await database.user.findUniqueOrThrow({
      where: { email: firstEmail },
    });
    expect(
      first.firstName === 'Integration' && first.phone === '+2348031234567',
      'Names and phone normalized',
    );
    expect(
      first.emailVerifiedAt === null && first.phoneVerifiedAt === null,
      'Verification fields remain unset',
    );
    expect(
      first.kind === 'CUSTOMER' && first.status === 'ACTIVE',
      'Registration creates only active customers',
    );
    expect(
      first.passwordHash.startsWith('$scrypt$131072$8$1$') &&
        !first.passwordHash.includes(registrationInput.password),
      'Only a secure password hash is stored',
    );

    stage = 'login/profile';
    const signedIn = await login(firstEmail);
    expect(signedIn.status === 200, 'Correct credentials accepted');
    const firstCookie = cookieOf(signedIn);
    expect(
      /HttpOnly/i.test(signedIn.headers.get('set-cookie')) &&
        /SameSite=Lax/i.test(signedIn.headers.get('set-cookie')),
      'Cookie has security attributes',
    );
    const publicUser = await signedIn.json();
    expect(
      !['password', 'passwordHash', 'token', 'tokenHash', 'kind'].some((key) =>
        Object.hasOwn(publicUser, key),
      ),
      'Login response excludes stored secrets',
    );
    const storedSession = await database.session.findUniqueOrThrow({
      where: { tokenHash: sessionTokenHash(firstCookie.split('=')[1]) },
    });
    expect(
      storedSession.userId === first.id && storedSession.revokedAt === null,
      'Cookie maps to its hashed database session',
    );
    const me = await profile(firstCookie);
    expect(
      me.status === 200 && (await me.json()).id === first.id,
      'Me identifies the correct customer',
    );
    expect(
      me.headers.get('cache-control') === 'no-store',
      'Profiles are not cacheable',
    );
    const unknown = await login(
      missingEmail,
      undefined,
      'incorrect integration-only password',
    );
    const wrong = await login(
      firstEmail,
      undefined,
      'incorrect integration-only password',
    );
    expect(
      unknown.status === 401 &&
        wrong.status === 401 &&
        JSON.stringify(await unknown.json()) ===
          JSON.stringify(await wrong.json()),
      'Invalid credentials have indistinguishable errors',
    );

    stage = 'rotation/revocation';
    const rotated = cookieOf(await login(firstEmail, firstCookie));
    expect(rotated !== firstCookie, 'Login rotates session tokens');
    expect((await profile(firstCookie)).status === 401, 'Old token revoked');
    const logout = await send('auth/logout', {}, rotated);
    expect(
      logout.status === 204 &&
        /Expires=Thu, 01 Jan 1970/i.test(logout.headers.get('set-cookie')),
      'Logout revokes and clears the cookie',
    );
    expect((await profile(rotated)).status === 401, 'Logged-out token denied');
    expect(
      (await send('auth/logout', {}, rotated)).status === 204,
      'Logout is idempotent',
    );

    stage = 'expiry/idle/account boundaries';
    let cookie = cookieOf(await login(firstEmail));
    let tokenHash = sessionTokenHash(cookie.split('=')[1]);
    await database.session.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await profile(cookie)).status === 401, 'Expired session denied');
    cookie = cookieOf(await login(firstEmail));
    tokenHash = sessionTokenHash(cookie.split('=')[1]);
    await database.session.update({
      where: { tokenHash },
      data: { lastSeenAt: new Date(Date.now() - 86401000) },
    });
    expect((await profile(cookie)).status === 401, 'Idle session denied');
    cookie = cookieOf(await login(firstEmail));
    await database.user.update({
      where: { id: first.id },
      data: { status: 'DISABLED' },
    });
    expect(
      (await profile(cookie)).status === 401 &&
        (await login(firstEmail)).status === 401,
      'Disabled customer denied both login and profile',
    );
    await database.user.update({
      where: { id: first.id },
      data: { status: 'ACTIVE', kind: 'STAFF' },
    });
    expect(
      (await profile(cookie)).status === 401 &&
        (await login(firstEmail)).status === 401,
      'Customer auth excludes staff identities',
    );
    await database.user.update({
      where: { id: first.id },
      data: { kind: 'CUSTOMER' },
    });
    const secondRegistration = await send('auth/register', {
      ...registrationInput,
      email: secondEmail,
    });
    expect(
      secondRegistration.status === 202,
      'A second independent customer can register',
    );
    const second = await database.user.findUniqueOrThrow({
      where: { email: secondEmail },
    });
    const secondCookie = cookieOf(await login(secondEmail));
    const isolated = await profile(secondCookie, `?userId=${first.id}`);
    expect(
      isolated.status === 200 && (await isolated.json()).id === second.id,
      'Me cannot select another account',
    );

    stage = 'persistent atomic rate limits';
    const config = new ConfigService(
      validateEnvironment({
        ...configuration,
        NODE_ENV: 'test',
        AUTH_RATE_LIMIT_NAMESPACE: namespace,
      }),
    );
    const limiter = new AuthRateLimitService(database, config);
    const parallel = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        limiter.consume('integration:atomic', atomicIdentity, 3, 60),
      ),
    );
    expect(
      parallel.filter((result) => result.status === 'fulfilled').length === 3 &&
        parallel.filter(
          (result) =>
            result.status === 'rejected' && result.reason.getStatus?.() === 429,
        ).length === 3,
      'Concurrent counters cannot bypass their limit',
    );
    const counterKey = rateLimitKey(
      namespace,
      'integration:atomic',
      atomicIdentity,
    );
    expect(
      (
        await database.authRateLimit.findUniqueOrThrow({
          where: { keyHash: counterKey },
        })
      ).attempts === 6,
      'Every concurrent attempt recorded',
    );
    await database.authRateLimit.update({
      where: { keyHash: counterKey },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await limiter.consume('integration:atomic', atomicIdentity, 3, 60);
    expect(
      (
        await database.authRateLimit.findUniqueOrThrow({
          where: { keyHash: counterKey },
        })
      ).attempts === 1,
      'Expired throttle window resets atomically',
    );
    const blocked = await send('auth/register', registrationInput);
    expect(
      blocked.status === 202,
      'Last permitted registration attempt accepted',
    );
    expect(
      (await send('auth/register', registrationInput)).status === 429,
      'Further duplicate registration rate limited',
    );
    await stopApi();
    await startApi();
    expect(
      (await send('auth/register', registrationInput)).status === 429,
      'Rate limits survive an API restart',
    );
    expect(
      (await profile(secondCookie)).status === 200,
      'Database sessions survive an API restart',
    );

    stage = 'OpenAPI';
    const document = await (await fetch(`${origin}/v1/docs-json`)).json();
    expect(
      [
        '/v1/auth/register',
        '/v1/auth/login',
        '/v1/auth/logout',
        '/v1/me',
      ].every((route) => document.paths[route]),
      'Auth routes documented',
    );
    expect(
      document.components.schemas.RegisterDto.properties.password.writeOnly ===
        true,
      'OpenAPI marks passwords write-only',
    );
    console.log(
      `Neon ${branch.name} authentication integration checks passed: ${checks}.`,
    );
  } catch (error) {
    // Assertion/driver errors can contain submitted secrets. Report stage only.
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      /^P\d{4}$/.test(String(error.code))
        ? String(error.code)
        : '';
    console.error(
      `Neon development authentication integration check failed at: ${stage}. ${failedCheck || 'Connection/request failure'}${code ? ` (${code})` : ''}; ${checks} checks completed.`,
    );
    process.exitCode = 1;
  } finally {
    await stopApi();
    try {
      // Exact fixture identifiers only; never delete existing customer data.
      await database.user.deleteMany({
        where: { email: { in: [firstEmail, secondEmail] } },
      });
      await database.authRateLimit.deleteMany({
        where: { keyHash: { in: keys } },
      });
      cleanupSucceeded = true;
    } catch {
      console.error(
        'Fixture cleanup failed; inspect this test run before retrying.',
      );
      process.exitCode = 1;
    }
    await database.$disconnect();
    if (cleanupSucceeded)
      console.log(
        'This run’s synthetic users, sessions, and rate-limit counters were removed.',
      );
  }
}

main().catch(() => {
  console.error(
    'Neon development verification failed before integration tests; no tests were run.',
  );
  process.exitCode = 1;
});
