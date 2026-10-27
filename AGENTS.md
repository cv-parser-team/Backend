# Agent Instructions

Use the project documentation as the source of truth:

- [README](README.md) for setup, commands, and public endpoints.
- [Architecture](docs/architecture.md) for boundaries, dependencies, database,
  errors, transactions, and testing strategy.
- [Adding a module](docs/adding-a-module.md) when creating or extending a feature.
- [Data model](docs/database/data-model.md) for entities and relationships.

## Working rules

- Read relevant files before editing and keep changes focused.
- Keep code simple, type-safe, and free of `any` and unnecessary abstractions.
- Prefer existing utilities and patterns over new dependencies.
- Do not make unrelated or major architectural changes without asking.
- Add or update tests for changed behavior.
- Run relevant tests and `npm run build`; only report checks that were executed.
