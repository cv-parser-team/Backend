# Architecture

LuminaCV is a modular monolith. It deploys as one application while keeping
business features isolated behind explicit module entry points.

## Project structure

```text
src/
├── app.ts                    # Fastify composition root
├── index.ts                  # Process bootstrap
├── config/                   # Environment-backed configuration
├── infrastructure/
│   ├── database/             # Pool, Drizzle, schema exports, DB errors
│   └── http/                 # Global HTTP error handling
├── modules/
│   ├── auth/                 # JWT authentication, token versions, guards
│   ├── candidates/           # Candidate profiles, claims, profile export
│   ├── documents/            # Candidate document upload and storage boundary
│   ├── extraction/           # AI-output contract and mapping to claim drafts
│   ├── normalization/        # Canonical terms, aliases, and claim normalization
│   ├── parsing/              # Text extraction from PDF and DOCX documents
│   └── users/                # Table, schemas, repository, service, routes
└── shared/                   # Module-independent contracts and errors
```

Feature modules own their behavior, persistence definitions, and tests.
Infrastructure contains application-wide technical integrations, while shared
contains small contracts that do not depend on a feature.

## Dependency direction

```text
HTTP route → service → repository → database
                 ↓
           business rules
```

- Routes translate HTTP requests and responses and attach JSON Schemas.
- Services implement business behavior and own transaction boundaries.
- Repositories expose persistence operations without HTTP concerns.
- Tables belong to their business module.
- `src/app.ts` is the composition root and registers infrastructure and modules.
- `src/index.ts` is only responsible for starting the process.

Dependencies must point inward along this chain. A repository must not call a
route or service, and shared code must not depend on a feature module.

## Module boundaries

A module exposes its Fastify plugin through `index.ts`. Files outside the
module should not import its routes, repository, or table directly. If one
module needs behavior owned by another, expose a narrow service interface
instead of reading the other module's tables.

Module design notes and diagrams live in `docs/modules/`, for example
[Candidates](modules/candidates.md).

Keep a module flat while it remains small. Introduce subdirectories such as
`domain/`, `application/`, and `infrastructure/` only when the number of files
or distinct concerns makes the flatter layout difficult to navigate.

## Shared infrastructure

The database plugin creates one PostgreSQL pool per application instance,
decorates Fastify with the typed Drizzle database, and closes the pool during
application shutdown. Database driver errors are translated before they leave
the repository layer.

The HTTP error-handler plugin produces one error envelope for application,
validation, and not-found errors. Feature routes should throw typed errors and
must not duplicate global error formatting.

The auth plugin verifies 15-minute JWT access tokens, reloads current role and
account status, and compares the token-version claim with PostgreSQL on every
protected request. A separately scoped 30-day JWT is kept in an HttpOnly,
SameSite cookie and can issue a new access token only while that same account
and token version remain valid. It exposes typed authentication and
authorization guards to feature modules. Logout increments the stored version,
invalidating all older access and refresh tokens without storing JWTs.

## Transactions

Services own transactions when multiple writes must succeed atomically. The
`UnitOfWork` in `infrastructure/database/unit-of-work.ts` runs such writes as
one transaction, even when different modules own them: it passes a
`DatabaseExecutor` to the work, and repository methods that must join the
transaction accept it as an optional last argument. Its first use ends a
document processing attempt. Do not add transactions to single repository
operations without a consistency requirement.

Deadlocks, serialization failures, unavailable locks, and lost connections are
mapped to `TransientDatabaseError`. `withTransientRetry` in
`infrastructure/database/transient-retry.ts` runs a whole transaction again, up
to three times in total, only for these errors; the `UnitOfWork` and the claim
transactions use it. Never retry a write that was refused because another
request changed the record first.

How duplicates, concurrent writes, and retries are handled is described in
[Duplicate and conflict resolution](duplicates-and-conflicts.md).

## Testing strategy

- Route tests use `Fastify.inject()` and verify validation and HTTP contracts.
- Service tests provide repository doubles and verify business rules.
- Repository integration tests use an isolated PostgreSQL database.
- Application tests verify plugin composition, global errors, and shutdown.

Tests must not silently connect to a shared development or production database.
