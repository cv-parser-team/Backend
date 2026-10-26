# LuminaCV API

Backend API for the LuminaCV talent and candidate platform. It is a TypeScript
modular monolith built with Fastify, PostgreSQL, Drizzle ORM, Ajv, and Vitest.

## Requirements

- Node.js 24 (see `.nvmrc`)
- npm
- Docker Compose for the local PostgreSQL instance

## Local development

```bash
nvm use
npm install
cp .env.example .env
set -a && source .env && set +a
npm run db:up
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
| `npm run build` | Type-check and compile TypeScript |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run db:up` | Start PostgreSQL |
| `npm run db:down` | Stop local containers |
| `npm run db:generate` | Generate a Drizzle migration |
| `npm run db:migrate` | Apply generated migrations |
| `npm run db:push` | Push schema changes during local development |
| `npm run db:studio` | Open Drizzle Studio |

## API

The currently registered user routes are:

- `GET /api/users`
- `GET /api/users/:id`
- `POST /api/users`

There is intentionally no health endpoint.

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
