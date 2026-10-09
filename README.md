# MFS backend

NestJS 11 with TypeScript, REST under `/v1`, PostgreSQL, and Prisma 7. Includes health/readiness, OpenAPI, customer authentication, and the customer vehicle garage. No frontend, staff login/RBAC/MFA, verification delivery, recovery, or later business features are included.

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
- Phone numbers are checked for a possible length and structure, then stored in E.164; Nigerian national format is accepted by default, as are possible international numbers. Exact carrier or number-block recognition is deliberately not required at signup. Phone is not a login identifier and is **not unique** in this slice; confirm the shared-number policy before introducing phone login/recovery.
- New passwords require 8–128 Unicode code points (at most 1,024 UTF-8 bytes). Passwords are never trimmed, truncated, or normalized. Salted scrypt uses `N=131072`, `r=8`, `p=1`, with constant-time comparison and at most two concurrent derivations per process. Unknown users still perform password verification work. No plaintext password is stored or logged.
- Registration returns the same `202` body and no cookie for both new and existing emails. Duplicate requests never replace credentials. Sign in separately. Invalid passwords, missing users, disabled accounts, and staff identities all receive `401` with `Invalid email or password`.
- Login creates a random 256-bit opaque token, delivered only in the cookie. Only its SHA-256 digest is stored in `sessions`. A supplied previous session is revoked on successful login. Default expiration is seven days absolute and 24 hours idle; `/me` checks account kind/status, expiry, and revocation and refreshes last-seen time. Logout revokes the stored token, not just the browser cookie.
- Cookies are host-only, HttpOnly, `SameSite=Lax`, and `Path=/`. Local HTTP uses `mfs_session`; secure environments use `__Host-mfs_session` with `Secure`. Production requires secure cookies, HTTPS browser origins, and HTTPS auth requests. Configure known proxy hops only behind a restricted reverse proxy; spoofed forwarding headers are ignored by default.
- **Every auth POST requires `Content-Type: application/json` and `X-MFS-CSRF: 1`, including logout.** Browser requests must come from an exact `AUTH_ALLOWED_ORIGINS` entry; credentialed CORS is restricted to that list. The custom header forces a preflight on cross-origin browser mutations and blocks simple form requests; SameSite is additional protection. This API currently expects a same-site frontend/API deployment, such as `mfsservicesng.com` and `api.mfsservicesng.com`.
- Browser clients must use `credentials: 'include'`; session tokens are not returned in JSON or available to JavaScript. OpenAPI includes request/response models, the cookie scheme, and CSRF requirements. Auth responses/errors use `Cache-Control: no-store`, and errors never echo database internals or submitted secrets.

`users` includes nullable `emailVerifiedAt` and `phoneVerifiedAt`; registration leaves both unset. `ACTIVE` means permitted to sign in, **not verified**. Unverified customers may sign in, access `/me`, and manage their own garage; do not treat the supplied email/phone as proven ownership for later sensitive workflows. Generic registration responses and throttles reduce enumeration, but signup-then-login probing cannot be fully eliminated without a verification gate. The gating policy remains an explicit business/security decision.

## Customer vehicle garage

All routes require the existing HttpOnly customer session cookie. Staff, disabled, expired, and revoked sessions are rejected by the existing session guard. Credentials-enabled CORS remains restricted to exact configured origins and now permits PATCH/DELETE. Every vehicle mutation requires `X-MFS-CSRF: 1`; POST/PATCH also require JSON. DELETE needs no body. Requests share the existing 120-per-IP-per-minute customer-session boundary; no new auth mechanism is introduced.

| Route                     | Response                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `POST /v1/vehicles`       | `201` with the created vehicle; ownership always comes from the session.           |
| `GET /v1/vehicles`        | `{ items, total, limit, offset }`, newest first with UUID as a stable tie breaker. |
| `GET /v1/vehicles/:id`    | The signed-in customer's vehicle.                                                  |
| `PATCH /v1/vehicles/:id`  | Updated vehicle; omitted fields stay unchanged and null clears optional fields.    |
| `DELETE /v1/vehicles/:id` | `204`; hard deletes the vehicle and its ownership association.                     |

Foreign and nonexistent vehicle IDs receive the same `404`. Reads, lists/counts, updates, and deletes are ownership-scoped at the database query, including the actual update/delete statement. Unknown body/query properties are rejected, so callers cannot assign an owner, normalized value, ID, or timestamps. Responses use an explicit vehicle-field projection, never customer credentials or ownership internals; errors and responses use `Cache-Control: no-store`.

- `category` is required: `BIKE`, `SALOON`, `SUV_PICKUP`, `TRUCK`, or `BUS_MINI_TRUCK`. Categories are independent database rows, seeded by migration; no category-management endpoints are added.
- All remaining details are optional/nullable so an unregistered or partially known vehicle can be saved: `name`, `registrationNumber`, `make`, `model`, `year`, `colour`, `chassisNumber`, `engineNumber`, `engineCapacity`, `usageType`, `stateOfRegistration`.
- `name` is a customer label such as Family car or Work van, up to 80 characters. It is trimmed/NFC-normalized, rejects control/format characters, and is not unique. Omit it to keep a current name unchanged on PATCH; send `null` to clear it. Existing vehicles remain unnamed.
- Registration display text is preserved exactly (up to 80 characters, nonblank, no control/format characters). The paired searchable value uses NFC, uppercase, and removes whitespace; punctuation is retained. Null clears both values. It has a nonunique index: duplicates within and across garages are allowed.
- Other text is trimmed/NFC-normalized, nonblank, and length-bounded. `year` must be a four-digit integer (1000–9999), with no age/current-year business rule. `engineCapacity` is text including the supplied unit, not a guessed numeric unit. `usageType` and `stateOfRegistration` remain text rather than an invented closed vocabulary.
- Lists accept `limit` (default 20, 1–100), `offset` (default 0, 0–100000), and optional `registrationNumber` for an exact normalized match. There is no cross-customer search.
- `vehicle_ownerships` separates individual ownership from vehicle details and allows an organization association to be introduced later without embedding fleet behavior now. Customer account deletion is restricted while it owns vehicles; no account-deletion feature is introduced.

Example JSON body:

```json
{
  "category": "SALOON",
  "name": "Family car",
  "registrationNumber": "ABC 123 LA",
  "make": "Toyota",
  "model": "Camry",
  "year": 2019,
  "colour": "Blue",
  "engineCapacity": "2.5 L",
  "usageType": "PRIVATE",
  "stateOfRegistration": "Lagos"
}
```

Migrations: `20261004150000_customer_vehicle_garage` and additive `20261004202825_vehicle_name`. Apply them to the existing verified Neon development link with `npm run db:migrate:development`; never use production, `neon deploy`, or a shadow/reset workflow. OpenAPI at `/v1/docs` documents the request/response fields, pagination, CSRF, and errors.

Run `npm test` for controlled foundation/auth/garage tests. `npm run test:vehicles:integration` verifies the pinned Neon development compute, starts a separate API on a temporary local port, checks real two-customer isolation and CRUD, and removes only its exact synthetic fixtures/counter keys. It does not migrate, deploy, or stop an existing development server.

Business confirmation still needed before stricter workflows: required details by registration stage, allowed usage types/states, canonical engine-capacity units, registration punctuation/format/duplicate policy, and future retention/deletion rules once requests or documents reference a vehicle. No uploads, services, pricing, compliance, or organization features are implemented here.

## Authentication security

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
