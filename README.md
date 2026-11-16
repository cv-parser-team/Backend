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

AI features use Gemini and need `LLM_API_KEY`, created in
[Google AI Studio](https://aistudio.google.com/docs/api-key). Keep the key in
your local `.env` only. Without it, CV extraction cannot run, and claim values
that exact and spelling matching cannot normalize are left for the candidate.
`NORMALIZATION_AI_ENABLED=false` turns AI normalization off even with a key;
`NORMALIZATION_AI_POLL_INTERVAL_MS` and `NORMALIZATION_AI_BATCH_SIZE` set how
often and how many requests the worker processes. See
[Normalization](docs/modules/normalization.md#ai-matching).

## Demo data

To try the application without creating accounts and claims by hand, fill
your local database with demo data:

```bash
npm run infra:up
npm run db:push
npm run demo:seed
```

Every demo account uses the password `Demo-Password-2026!`.

| Account | Role | What it shows |
| --- | --- | --- |
| `sara@demo.luminacv.test` | Candidate | A full profile with an accepted claim of every type, a rejected extracted skill, and an extracted job waiting for review; the export contains the accepted claims only |
| `omar@demo.luminacv.test` | Candidate | Normalization: `JavaScript` (exact), `Postgres` (alias), `Pyhton` (spelling correction), `Server-side Engineer` and `Bachelors in Computer Science` (AI), `Prodject Manager` (ambiguous, then AI), and `Underwater Basket Weaving` (no term) |
| `lina@demo.luminacv.test` | Candidate | A processed CV with three extracted claims and two review items waiting for review |
| `reviewer@demo.luminacv.test` | Reviewer | |
| `admin@demo.luminacv.test` | Admin | |

- Demo accounts use the reserved `demo.luminacv.test` domain. `demo:seed`
  first removes the previous demo data, so running it again gives the same
  data without duplicates. `demo:reset` removes it, with everything the demo
  users own and their files. Neither touches any other data.
- Both commands refuse to run when `NODE_ENV` is `production`.
- `demo:seed` loads the normalization dictionary if needed. Omar's AI values
  are matched by the worker (`npm run worker:dev`) when `LLM_API_KEY` is set;
  without it they stay unmatched.
- The demo data lives in `src/tools/demo/demo-data.ts`. Tests check that every
  claim passes the API's value rules and that Omar's values reach every
  normalization step.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API in watch mode |
| `npm run worker:dev` | Start the worker in watch mode: document processing and AI normalization requests |
| `npm run worker` | Start the compiled worker: document processing and AI normalization requests |
| `npm run parsing:inspect -- [file] [output] [--llm]` | Write a visual HTML parsing report; `--llm` embeds structured AI claims in the same report |
| `npm run parsing:inspect:all` | Regenerate parsing reports for every PDF and DOCX in `testResumes` |
| `npm run llm:inspect -- [output.html]` | Run one tracked candidate-extraction request and write a formatted HTML claims report (defaults to `llm-inspection.html`) |
| `npm run normalization:seed` | Load the starting normalization dictionary; adds only what is missing |
| `npm run demo:seed` | Replace all demo data with a fresh copy (see [Demo data](#demo-data)) |
| `npm run demo:reset` | Remove all demo data |
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

Database integration tests are opt-in and require a separately provisioned
database whose name contains `test`. They apply the project migrations before
running and refuse any URL that does not identify a test-scoped database.
Start PostgreSQL and create the test database once:

```bash
npm run db:up
docker compose exec postgres createdb -U postgres luminacv_test
```

Then run the integration tests:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgrespassword@localhost:5432/luminacv_test \
RUN_DATABASE_INTEGRATION_TESTS=true \
npx vitest run src/modules/candidates/candidates.repository.integration.test.ts
```

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
- `GET /api/candidates/me/claims/merge-proposal` (`leftClaimId` and `rightClaimId`; read-only)
- `POST /api/candidates/me/claims/coalesce` (safe pending duplicates remain staged)
- `POST /api/candidates/me/claims/merge` (candidate confirmation accepts and exports the survivor)
- `GET /api/candidates/me/claims/:claimId`
- `PUT /api/candidates/me/claims/:claimId`
- `PATCH /api/candidates/me/claims/:claimId/review` (`accepted` or `rejected`)
- `DELETE /api/candidates/me/claims/:claimId`
- `POST /api/candidates/me/documents?purpose=source` (one or more multipart `file` fields)
- `GET /api/candidates/me/documents`
- `GET /api/candidates/me/documents/:documentId`
- `GET /api/candidates/me/documents/:documentId/content`
- `DELETE /api/candidates/me/documents/:documentId`
- `GET /api/candidates/me/extraction-review-items` (optional `documentId` and `status` filters; status defaults to `pending`)
- `PATCH /api/candidates/me/extraction-review-items/:reviewItemId/dismiss`
- `POST /api/candidates/me/extraction-review-items/:reviewItemId/resolve`

There is intentionally no health endpoint.

### Concurrent edits

The profile and each claim carry a `version`, returned in the body and as an
`ETag` header. To make sure an edit does not overwrite a change made in
another tab or by another request, send the version you read:

```http
PUT /api/candidates/me/claims/:claimId
If-Match: "3"
```

`PATCH /api/candidates/me`, claim review, and
`DELETE /api/candidates/me/claims/:claimId` accept `If-Match` the same way. If
the record changed since, the request fails with `409 VERSION_CONFLICT`, and
`error.details.current` holds the record as it is now. `If-Match` is optional
for now; without it, edits are not checked.

Dismissal of an extraction review item also accepts `If-Match` and returns the
new version in its `ETag` header. Dismissed items no longer appear in the
pending review-item list.

Resolution accepts corrected claim `values` and `If-Match`. It atomically
creates an accepted extracted claim, marks the review item resolved, links the
two records, and returns the review item's new version in `ETag`.

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
