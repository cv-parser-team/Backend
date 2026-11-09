# LuminaCV API

Backend API for the LuminaCV talent and candidate platform. It is a TypeScript
modular monolith built with Fastify, PostgreSQL, Drizzle ORM, Ajv, and Vitest.

## Requirements

- Node.js 24 (see `.nvmrc`)
- npm
- Docker Compose for the local PostgreSQL and RabbitMQ instances

## Local development

```bash
nvm use
npm install
cp .env.example .env
set -a && source .env && set +a
npm run infra:up
npm run db:push
npm run dev
```

The API listens on `http://localhost:4000` by default. Environment variables
must be exported by your shell or development environment; the application
does not load `.env` files itself.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API in watch mode |
| `npm run parsing:inspect` | Select a PDF or DOCX and write a visual HTML parsing report |
| `npm run parsing:inspect:all` | Regenerate parsing reports for every PDF and DOCX in `testResumes` |
| `npm run build` | Type-check and compile TypeScript |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run infra:up` | Start PostgreSQL and RabbitMQ |
| `npm run infra:down` | Stop local infrastructure containers |
| `npm run infra:logs` | Follow PostgreSQL and RabbitMQ logs |
| `npm run messaging:up` | Start RabbitMQ |
| `npm run messaging:down` | Stop RabbitMQ |
| `npm run messaging:logs` | Follow RabbitMQ logs |
| `npm run db:up` | Start PostgreSQL |
| `npm run db:down` | Stop local containers |
| `npm run db:generate` | Generate a Drizzle migration |
| `npm run db:migrate` | Apply generated migrations |
| `npm run db:push` | Push schema changes during local development |
| `npm run db:studio` | Open Drizzle Studio |

## API

The authentication routes are:

- `POST /api/auth/register`
- `POST /api/auth/sign-in`
- `POST /api/auth/logout` (Bearer token required)

The protected user routes are:

- `GET /api/users` (admin only)
- `GET /api/users/:id` (self or admin)

The candidate profile routes require a Bearer token with the `candidate` role
and always act on the authenticated user's own profile:

- `POST /api/candidates/me` (create the profile)
- `GET /api/candidates/me`
- `PATCH /api/candidates/me`
- `GET /api/candidates/me/profile` (structured JSON with accepted claims only)
- `POST /api/candidates/me/claims` (add a manual claim)
- `GET /api/candidates/me/claims` (optional `type` and `status` filters)
- `PUT /api/candidates/me/claims/:claimId`
- `DELETE /api/candidates/me/claims/:claimId`
- `POST /api/candidates/me/documents?purpose=source` (one or more multipart `file` fields)
- `GET /api/candidates/me/documents`
- `GET /api/candidates/me/documents/:documentId`
- `GET /api/candidates/me/documents/:documentId/content`
- `DELETE /api/candidates/me/documents/:documentId`

There is intentionally no health endpoint.

## Authentication

Registration and sign-in return a signed JWT access token. Send it to protected
routes with `Authorization: Bearer <token>`. Access tokens expire after 15
minutes and are not refreshable; the user signs in again after expiry.

Each JWT includes the user's token version. Logout increments the stored
version and immediately invalidates all access tokens previously issued to that
user. `JWT_SECRET` must contain at least 32 characters; configure the expected
issuer and audience with `JWT_ISSUER` and `JWT_AUDIENCE`.

## Architecture

Features follow `routes -> services -> repositories -> database`. See
[Architecture](docs/architecture.md) for the project structure and dependency
rules, [Adding a module](docs/adding-a-module.md) for the feature checklist, and
[Functional requirements](docs/requirements.md) for the versioned product
behavior.

## Database schema

Feature modules own their Drizzle tables. The central
`src/infrastructure/database/schema.ts` file only re-exports those tables so
Drizzle Kit can discover them. Generated migrations belong in
`src/infrastructure/database/migrations/`.

See the [Data model](docs/database/data-model.md) for the implemented schema and
its relationship to the editable target domain ERD.

The default local connection is:

```text
postgresql://postgres:postgrespassword@localhost:5432/luminacv
```

Override it with `DATABASE_URL` outside local development.

The default local RabbitMQ connection is:

```text
amqp://luminacv:luminacvpassword@localhost:5672
```

The RabbitMQ management UI is available at `http://localhost:15672` using the
local username `luminacv` and password `luminacvpassword`. Override the broker
connection with `RABBITMQ_URL` outside local development.
