# Adding a module

Create a directory under `src/modules/<feature>/` and keep all feature-owned
code in it.

## Suggested files

```text
<feature>/
├── index.ts                  # Public Fastify module plugin
├── <feature>.table.ts        # Drizzle table definitions
├── <feature>.schemas.ts      # JSON Schemas and inferred request types
├── <feature>.repository.ts   # Persistence interface and implementation
├── <feature>.service.ts      # Business behavior
├── <feature>.routes.ts       # HTTP endpoints
└── <feature>.test.ts         # Focused module tests
```

Only create files that the feature needs. A read-only module, for example, may
not require a table.

## Checklist

1. Define request schemas with `as const` and infer their TypeScript types.
2. Define a narrow repository interface close to its implementation.
3. Inject the repository into the service factory.
4. Inject the service into the routes.
5. Compose those dependencies in the module's `index.ts`.
6. Register the module with its URL prefix in `src/app.ts`.
7. Re-export new Drizzle tables from
   `src/infrastructure/database/schema.ts`.
8. Add route-validation and service-behavior tests.
9. Run `npm run build` and `npm test`.
10. Update the API list in the root README when public endpoints change.

Avoid importing another module's repository or table. Expose an intentional
service interface when features need to collaborate.
