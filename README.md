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
| `npm run worker:dev` | Start the document-processing worker in watch mode |
| `npm run worker` | Start the compiled document-processing worker |
| `npm run parsing:inspect` | Select a PDF or DOCX and write a visual HTML parsing report |
| `npm run parsing:inspect:all` | Regenerate parsing reports for every PDF and DOCX in `testResumes` |
| `npm run llm:inspect` | Send one synthetic structured-output request to the configured LLM |
| `npm run normalization:seed` | Load the starting normalization dictionary; adds only what is missing |
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

### Concurrent edits

The profile and each claim carry a `version`, returned in the body and as an
`ETag` header. To make sure an edit does not overwrite a change made in
another tab or by another request, send the version you read:

```http
PUT /api/candidates/me/claims/:claimId
If-Match: "3"
```

`PATCH /api/candidates/me` and `DELETE /api/candidates/me/claims/:claimId`
accept `If-Match` the same way. If the record changed since, the request fails
with `409 VERSION_CONFLICT`, and `error.details.current` holds the record as it
is now. `If-Match` is optional for now; without it, edits are not checked.

Uploading a file whose earlier copy is still being deleted returns
`409 DOCUMENT_BEING_DELETED` for that file; upload it again shortly. A request
that hits a temporary database conflict, such as a deadlock, is retried
automatically and returns `503 TRANSIENT_DATABASE_ERROR` only if it keeps
failing.

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

RabbitMQ declares a durable dead-letter companion for each application queue.
Permanent parse failures and malformed messages from
`document-processing.parse-document` are routed to
`document-processing.parse-document.dead-letter`; retryable failures remain on
the main queue. If the main queue already exists locally without dead-letter
arguments, delete that queue through the management UI before restarting the
API or worker so RabbitMQ can recreate it with the new topology.
