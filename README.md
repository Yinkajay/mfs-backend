# MFS backend

NestJS 11 with TypeScript, REST under `/v1`, PostgreSQL, and Prisma 7. Includes health/readiness, OpenAPI, and the initial customer authentication slice. No frontend, staff login/RBAC/MFA, verification delivery, recovery, or later business features are included.

## Prerequisites

- Node.js **24 LTS** and npm 10 or newer. `.nvmrc` records the Node version.
- Docker Desktop or Docker Engine with Compose v2 for the local database. Start the Docker engine before running `db:up`.

Run commands from this standalone backend repository's root (`backend/` in the local parent workspace).

## Local setup

Use this section only for a fresh local Compose configuration. If `.env` already targets Neon, use **Neon development** below instead; do not run the generic local migration steps against a remote database.

```sh
cd backend
npm ci
```

Create `.env` from `.env.example` on a fresh checkout. Skip this command if `.env` already exists; the exclusive copy also prevents overwriting an existing file:

```sh
node -e "const fs = require('node:fs'); fs.copyFileSync('.env.example', '.env', fs.constants.COPYFILE_EXCL)"
npm run db:up
npm run prisma:generate
npm run db:migrate:deploy
npm run dev
```

Compose starts PostgreSQL 17 on `127.0.0.1:5433`. Its named volume retains data when you run `npm run db:down`. The API listens on `127.0.0.1:3001`, separate from the frontend's port 3000.

If you change database credentials, port, or name, update both the `POSTGRES_*` values and `DATABASE_URL`. Changing credentials in `.env` does not change an already initialized PostgreSQL volume's credentials.

## Neon development

The current ignored `.neon` pins project `nameless-feather-21505568`, branch `development` (`br-restless-fog-b4plxcc9`). `.env` contains its pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED`. Never commit either file or print their credentials. Do not replace this existing `.env` with the local template.

The API uses the pooled URL; Prisma CLI commands prefer the direct URL and fall back to `DATABASE_URL` for local Compose. Neon connections explicitly use `sslmode=verify-full` in memory for certificate/hostname verification, without rewriting or printing the saved URLs. No Docker database is needed when using Neon.

For an already authenticated Neon CLI and the existing link:

```sh
neon env pull --project-id nameless-feather-21505568 --branch development --file .env --service postgres
npm run db:migrate:development
npm run prisma:generate
npm run dev
```

`db:migrate:development` verifies the pinned project/branch, expiration, both connection hosts against Neon's development compute, matching database/credentials, and ignored files before running **Prisma** `migrate deploy`. Conflicting runtime database overrides are rejected. This is not `neon deploy` and does not provision services. Do not run `prisma migrate dev` against Neon: it may need a shadow database. The checked-in initial migration was generated with a local schema diff and includes a transaction; no reset/baseline was used.

## Endpoints

| Endpoint                 | Purpose                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`         | Process liveness; returns `200` without querying PostgreSQL.                                                                |
| `GET /v1/health/ready`   | Runs `SELECT 1` through Prisma; returns `200` when ready or `503` when PostgreSQL is unavailable.                           |
| `GET /v1/docs`           | Swagger UI when enabled.                                                                                                    |
| `GET /v1/docs-json`      | Generated OpenAPI JSON when enabled.                                                                                        |
| `POST /v1/auth/register` | Register a customer. Always `202` for a valid new or existing email; no session or user object returned.                    |
| `POST /v1/auth/login`    | Email/password login. Returns the safe customer profile and sets an HttpOnly session cookie.                                |
| `POST /v1/auth/logout`   | Revoke the presented session and clear its cookie. Idempotent `204`, including missing/expired cookies.                     |
| `GET /v1/me`             | Return only the signed-in customer's public profile; `401` for missing, expired, revoked, or unavailable customer sessions. |

```sh
curl http://127.0.0.1:3001/v1/health
curl http://127.0.0.1:3001/v1/health/ready
```

Readiness errors omit database credentials and internal error details. Prisma connects lazily, and shutdown hooks release its connection pool. The connection and query timeouts are three seconds.

## Customer authentication contract

Register with exactly `firstName`, `lastName`, `email`, `phone`, and `password`; login takes exactly `email` and `password`. Unknown properties, including account kind/status and verification timestamps, are rejected.

- Names are trimmed, whitespace-normalized, and NFC-normalized; control/format characters are rejected. Email is trimmed and lowercased, with no provider-specific dot/plus rewriting. It is the unique login identifier.
- Phone numbers are validated with full libphonenumber metadata and stored in E.164; Nigerian national format is accepted by default, as are valid international numbers. Phone is not a login identifier and is **not unique** in this slice; confirm the shared-number policy before introducing phone login/recovery.
- New passwords require 15–128 Unicode code points (at most 1,024 UTF-8 bytes). Passwords are never trimmed, truncated, or normalized. Salted scrypt uses `N=131072`, `r=8`, `p=1`, with constant-time comparison and at most two concurrent derivations per process. Unknown users still perform password verification work. No plaintext password is stored or logged.
- Registration returns the same `202` body and no cookie for both new and existing emails. Duplicate requests never replace credentials. Sign in separately. Invalid passwords, missing users, disabled accounts, and staff identities all receive `401` with `Invalid email or password`.
- Login creates a random 256-bit opaque token, delivered only in the cookie. Only its SHA-256 digest is stored in `sessions`. A supplied previous session is revoked on successful login. Default expiration is seven days absolute and 24 hours idle; `/me` checks account kind/status, expiry, and revocation and refreshes last-seen time. Logout revokes the stored token, not just the browser cookie.
- Cookies are host-only, HttpOnly, `SameSite=Lax`, and `Path=/`. Local HTTP uses `mfs_session`; secure environments use `__Host-mfs_session` with `Secure`. Production requires secure cookies, HTTPS browser origins, and HTTPS auth requests. Configure known proxy hops only behind a restricted reverse proxy; spoofed forwarding headers are ignored by default.
- **Every auth POST requires `Content-Type: application/json` and `X-MFS-CSRF: 1`, including logout.** Browser requests must come from an exact `AUTH_ALLOWED_ORIGINS` entry; credentialed CORS is restricted to that list. The custom header forces a preflight on cross-origin browser mutations and blocks simple form requests; SameSite is additional protection. This API currently expects a same-site frontend/API deployment, such as `mfsservicesng.com` and `api.mfsservicesng.com`.
- Browser clients must use `credentials: 'include'`; session tokens are not returned in JSON or available to JavaScript. OpenAPI includes request/response models, the cookie scheme, and CSRF requirements. Auth responses/errors use `Cache-Control: no-store`, and errors never echo database internals or submitted secrets.

`users` includes nullable `emailVerifiedAt` and `phoneVerifiedAt`; registration leaves both unset. `ACTIVE` means permitted to sign in, **not verified**. Until verification is built, unverified customers can use login and `/me` only; do not treat the supplied email/phone as proven ownership for later sensitive workflows. Generic registration responses and throttles reduce enumeration, but signup-then-login probing cannot be fully eliminated without a verification gate. The gating policy remains an explicit business/security decision.

### Brute-force protection

PostgreSQL `auth_rate_limits` stores atomic, expiring counters shared by API instances and retained across restarts. Keys hash a namespace, scope, and normalized email or socket IP; plaintext identifiers are not stored in the counter table. All instances must use the same namespace. Hashing here is not a claim of irreversible anonymization.

Defaults per 15-minute fixed window: login 30 attempts/IP and 10/email; registration 10/IP and 3/email. Both successes and failures consume attempts; nonexistent emails follow the same rules. `/me` and logout additionally allow 120 requests/IP/minute. Blocked counters return generic `429` plus `Retry-After`; counters reset after the window. Bounded opportunistic cleanup removes expired counters without a worker. Database failure fails auth closed with a sanitized `503`. No permanent account lock is applied by an unauthenticated attacker.

### Remaining auth work

- Email/phone verification delivery and confirmation; decide which future actions require verified ownership.
- Password recovery, password-change/revocation policy, user-facing session listing/revocation, and session-data retention/cleanup policy.
- Frontend integration (including password-policy alignment), public API origin/proxy/HTTPS configuration, and terms/privacy consent requirements before launch.
- Staff provisioning/login, MFA, and RBAC are separate future work. The account-kind discriminator already prevents staff identities using these customer endpoints; there are no staff routes or role tables here.

Security references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [authentication responses and throttling](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), and [CSRF custom-header protection](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Configuration

Nest loads `.env` and validates settings at startup. Runtime variables take precedence for the API; development migration/test helpers reject conflicting database overrides. Prisma prefers `DATABASE_URL_UNPOOLED` when present. New auth settings have safe local defaults, so the existing Neon `.env` need not be rewritten for local use.

| Variable                                                             | Default / requirement                                                                                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                           | `development`; accepts `development`, `test`, or `production`.                                                                                                              |
| `HOST`                                                               | `127.0.0.1`; set to `0.0.0.0` when the API needs to bind inside a container.                                                                                                |
| `PORT`                                                               | `3001`; integer from 1 to 65535.                                                                                                                                            |
| `DATABASE_URL`                                                       | Required PostgreSQL URL with a host and database name.                                                                                                                      |
| `DATABASE_URL_UNPOOLED`                                              | Direct Neon URL for Prisma CLI; optional for local Compose.                                                                                                                 |
| `AUTH_ALLOWED_ORIGINS`                                               | Comma-separated exact HTTP(S) origins. Local defaults include localhost/127.0.0.1 ports 3000 (frontend) and 3001 (Swagger). Production/secure-cookie origins must be HTTPS. |
| `SESSION_COOKIE_SECURE`                                              | Literal `true`/`false`; defaults to true in production and false otherwise. Use true for every public HTTPS environment; false is rejected in production.                   |
| `SESSION_TTL_SECONDS`, `SESSION_IDLE_TTL_SECONDS`                    | Defaults 604800/86400. Idle duration cannot exceed absolute lifetime.                                                                                                       |
| `AUTH_RATE_LIMIT_NAMESPACE`                                          | Default `customer-auth`; identical across API instances. Integration tests use a unique isolated namespace.                                                                 |
| `AUTH_RATE_WINDOW_SECONDS`                                           | Default 900 seconds.                                                                                                                                                        |
| `AUTH_LOGIN_IP_LIMIT`, `AUTH_LOGIN_ACCOUNT_LIMIT`                    | Defaults 30 and 10.                                                                                                                                                         |
| `AUTH_REGISTER_IP_LIMIT`, `AUTH_REGISTER_ACCOUNT_LIMIT`              | Defaults 10 and 3.                                                                                                                                                          |
| `TRUST_PROXY_HOPS`                                                   | Default 0; only configure for a known, restricted proxy topology.                                                                                                           |
| `SWAGGER_ENABLED`                                                    | Literal `true` or `false`; defaults to enabled outside production and disabled in production. The local template explicitly enables it.                                     |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Local Compose settings; see `.env.example`.                                                                                                                                 |

Use separate settings and databases for development, staging, and production. Run a production API behind HTTPS; this local setup does not configure production hosting.

## Development and verification

```sh
npm run check
npm run typecheck
npm run format
npm run build
npm start
```

`check` validates Prisma, runs ESLint/format checks, builds the API, and runs foundation/auth tests with controlled database storage. Tests cover normalization, input bounds, safe projections, generic auth responses, CSRF/origin handling, brute-force limits, cookie flags, rotation/revocation/expiry, disabled/staff boundaries, failure sanitization, and real scrypt.

The opt-in Neon suite needs the existing authenticated CLI/link, ignored `.env`, and applied migration:

```sh
npm run test:integration
```

It verifies the development compute before connecting, exercises real HTTP/database flows, proves atomic counters and persistence across an API restart, and removes only its unique synthetic users/sessions and exact counter keys afterward. It never uses production and is not part of the ordinary unit test command.

`build` regenerates the Prisma client and compiles into `dist/`. Generation needs valid configuration but does not require a running database. The generated client is ignored by Git and is compiled with the API.

Scoped npm overrides update vulnerable transitive dependencies in Swagger and Prisma tooling. Review those overrides when upgrading their parent packages; Prisma generation, configuration, and API checks cover compatibility here.

## Prisma migrations

`20261003140000_customer_auth` adds users, sessions, and persistent authentication counters, plus indexes, the session foreign key, and normalization constraints. Schema changes always include a reviewed, committed SQL migration; migration files remain trackable.

For future assigned schema work on an isolated **local** Compose database:

```sh
npm run db:migrate -- --name describe_the_change
npm run prisma:generate
```

Review and commit the SQL migration and schema together. Use the guarded `db:migrate:development` for the current Neon branch; the generic `db:migrate:deploy` is only for a separately verified target during a controlled deployment. Prisma 7 does not regenerate the client automatically after migrations.

`.gitignore` excludes local configuration, dependencies, generated code, build output, logs, and editor/OS files. It keeps `.env.example`, `package-lock.json`, source, and migrations trackable.

The independent backend `.git` repository is preserved. No parent/frontend restructuring is required.

Reference: the local backend blueprint at `../docs/MFS_Backend_Architecture_Codex_Blueprint.pdf`, [NestJS Prisma integration](https://docs.nestjs.com/recipes/prisma), and [Prisma 7 runtime requirements](https://www.prisma.io/docs/orm/v7/reference/system-requirements).
