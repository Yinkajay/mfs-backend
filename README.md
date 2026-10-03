# MFS backend foundation

NestJS 11 with TypeScript, a REST API under `/v1`, PostgreSQL, and Prisma 7. This foundation contains configuration, database connectivity, health checks, and OpenAPI documentation. The schema has no business models or SQL migrations yet.

## Prerequisites

- Node.js **24 LTS** and npm 10 or newer. `.nvmrc` records the Node version.
- Docker Desktop or Docker Engine with Compose v2 for the local database. Start the Docker engine before running `db:up`.

Run commands inside `backend/`. The repository's existing root commands still target the frontend. From the root, `npm --prefix backend run <script>` runs a backend command.

## Local setup

```sh
cd backend
npm ci
```

Create `.env` from `.env.example` on a fresh checkout. Skip this command if `.env` already exists; the exclusive copy also prevents overwriting an existing file:

```sh
node -e "const fs = require('node:fs'); fs.copyFileSync('.env.example', '.env', fs.constants.COPYFILE_EXCL)"
npm run db:up
npm run prisma:generate
npm run dev
```

Compose starts PostgreSQL 17 on `127.0.0.1:5433`. Its named volume retains data when you run `npm run db:down`. The API listens on `127.0.0.1:3001`, separate from the frontend's port 3000.

If you change database credentials, port, or name, update both the `POSTGRES_*` values and `DATABASE_URL`. Changing credentials in `.env` does not change an already initialized PostgreSQL volume's credentials.

## Endpoints

| Endpoint               | Purpose                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /v1/health`       | Process liveness; returns `200` without querying PostgreSQL.                                      |
| `GET /v1/health/ready` | Runs `SELECT 1` through Prisma; returns `200` when ready or `503` when PostgreSQL is unavailable. |
| `GET /v1/docs`         | Swagger UI when enabled.                                                                          |
| `GET /v1/docs-json`    | Generated OpenAPI JSON when enabled.                                                              |

```sh
curl http://127.0.0.1:3001/v1/health
curl http://127.0.0.1:3001/v1/health/ready
```

Readiness errors omit database credentials and internal error details. Prisma connects lazily, and shutdown hooks release its connection pool. The connection and query timeouts are three seconds.

## Configuration

Nest loads `.env` and validates settings at startup. Environment variables supplied by the runtime take precedence. The Prisma CLI reads the same `DATABASE_URL` through `prisma.config.ts`.

| Variable                                                             | Default / requirement                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                           | `development`; accepts `development`, `test`, or `production`.                                                                          |
| `HOST`                                                               | `127.0.0.1`; set to `0.0.0.0` when the API needs to bind inside a container.                                                            |
| `PORT`                                                               | `3001`; integer from 1 to 65535.                                                                                                        |
| `DATABASE_URL`                                                       | Required PostgreSQL URL with a host and database name.                                                                                  |
| `SWAGGER_ENABLED`                                                    | Literal `true` or `false`; defaults to enabled outside production and disabled in production. The local template explicitly enables it. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Local Compose settings; see `.env.example`.                                                                                             |

Use separate settings and databases for development, staging, and production. Run a production API behind HTTPS; this local setup does not configure production hosting.

## Development and verification

```sh
npm run check
npm run typecheck
npm run format
npm run build
npm start
```

`check` validates Prisma, runs ESLint and the formatting check, builds the API, and runs foundation tests. Tests exercise configuration validation, versioned HTTP routes, readiness success/failure, and OpenAPI enablement with a controlled Prisma substitute. To verify a real PostgreSQL connection, start Compose and call the readiness endpoint.

`build` regenerates the Prisma client and compiles into `dist/`. Generation needs valid configuration but does not require a running database. The generated client is ignored by Git and is compiled with the API.

Scoped npm overrides update vulnerable transitive dependencies in Swagger and Prisma tooling. Review those overrides when upgrading their parent packages; Prisma generation, configuration, and API checks cover compatibility here.

## Prisma migrations

`prisma/schema.prisma` defines only the PostgreSQL datasource and client generator. `prisma/migrations/migration_lock.toml` records the database provider. There is no artificial table or initial SQL migration.

When an assigned task adds or changes a model:

```sh
npm run db:migrate -- --name describe_the_change
npm run prisma:generate
```

Review and commit the generated SQL migration and schema together. Apply committed migrations during a controlled deployment with `npm run db:migrate:deploy`. Use `npm run db:migrate:status` to inspect migration state. Prisma 7 does not regenerate the client automatically after migrations.

`.gitignore` excludes local configuration, dependencies, generated code, build output, logs, and editor/OS files. It keeps `.env.example`, `package-lock.json`, source, and migrations trackable.

The pre-existing `backend/.git` directory is preserved. Whether to retain that independent repository or consolidate it into the parent repository remains a repository-management decision.

Reference: the local backend blueprint at `../docs/MFS_Backend_Architecture_Codex_Blueprint.pdf`, [NestJS Prisma integration](https://docs.nestjs.com/recipes/prisma), and [Prisma 7 runtime requirements](https://www.prisma.io/docs/orm/v7/reference/system-requirements).
