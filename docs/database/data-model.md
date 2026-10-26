# Data model

This document describes the conceptual database model. Drizzle table
definitions in `src/modules/` are the implementation source of truth; update
this document whenever entities or relationships change.

## Entity relationship diagram

```mermaid
erDiagram
    USERS {
        uuid user_id PK
        text name
        text email UK
        text password_hash "nullable"
        user_role role
        account_status account_status
        timestamptz email_verified_at "nullable"
        timestamptz created_at
        timestamptz updated_at
    }
```

The current schema contains one entity and therefore has no inter-entity
relationships.

## Users

Owned by the `users` module and defined in
`src/modules/users/users.table.ts`.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `user_id` | UUID | Primary key, generated | Stable user identifier |
| `name` | Text | Required | Display name |
| `email` | Text | Required, unique | Normalized sign-in/contact address |
| `password_hash` | Text | Nullable | Password-derived credential; never returned by the API |
| `role` | `user_role` | Required, defaults to `candidate` | Authorization category |
| `account_status` | `account_status` | Required, defaults to `active` | Account lifecycle state |
| `email_verified_at` | Timestamp with time zone | Nullable | Email verification time |
| `created_at` | Timestamp with time zone | Required, generated | Creation time |
| `updated_at` | Timestamp with time zone | Required, generated | Last update time |

### Enumerations

- `user_role`: `candidate`, `admin`
- `account_status`: `active`, `suspended`, `disabled`

## Maintenance rules

- Keep physical column details aligned with the owning Drizzle table.
- Show foreign-key cardinality in the ER diagram when relationships are added.
- Record the business meaning of relationships and important constraints here.
- Use migrations for database evolution; do not treat this document as an
  executable schema.
