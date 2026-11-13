# Data model

This document describes the implemented database model. Drizzle table
definitions in `src/modules/` are the implementation source of truth; update
this document whenever entities or relationships change.

The readable [target domain ERD](erd.md) explores the broader model implied by
the functional requirements, with an [editable diagrams.net source](erd.drawio).
It is a design input, not a representation of the current database, and must be
reconciled with this document as features are implemented. Its upstream
diagrams.net file is available in
[Google Drive](https://app.diagrams.net/#G1fQqzUKwOfsyoHleLbRbM1uaNwr-d5GiQ#%7B%22pageId%22%3A%22erd-v3-3%22%7D).

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
    AUTH_TOKEN_VERSIONS {
        uuid user_id PK, FK
        integer version
        timestamptz updated_at
    }
    CANDIDATES {
        uuid candidate_id PK
        uuid user_id FK, UK
        text full_name
        text headline "nullable"
        text summary "nullable"
        text phone "nullable"
        text location "nullable"
        text contact_email "nullable"
        jsonb profile_links
        integer version
        timestamptz created_at
        timestamptz updated_at
    }
    CLAIMS {
        uuid claim_id PK
        uuid candidate_id FK
        claim_type claim_type
        claim_origin origin
        claim_status status
        uuid extraction_invocation_id "nullable"
        uuid extraction_document_id "nullable"
        jsonb extraction_raw_values "nullable"
        jsonb extraction_field_sources "nullable"
        boolean extraction_current "nullable"
        integer version
        timestamptz created_at
        timestamptz updated_at
    }
    SKILL_DETAILS {
        uuid claim_id PK, FK
        text name
    }
    EMPLOYMENT_DETAILS {
        uuid claim_id PK, FK
        text employer
        text job_title
        date start_date
        date end_date "nullable"
        text location "nullable"
        text description "nullable"
        text[] skills
    }
    EDUCATION_DETAILS {
        uuid claim_id PK, FK
        text institution
        text degree
        text field_of_study "nullable"
        date start_date
        date end_date "nullable"
    }
    CERTIFICATION_DETAILS {
        uuid claim_id PK, FK
        text title
        text issuer
        date issue_date
        date expiry_date "nullable"
        text credential_id "nullable"
    }
    LANGUAGE_DETAILS {
        uuid claim_id PK, FK
        text name
        text proficiency "nullable"
    }
    PROJECT_DETAILS {
        uuid claim_id PK, FK
        text name
        text description "nullable"
        text role "nullable"
        text url "nullable"
        date start_date "nullable"
        date end_date "nullable"
        text[] skills
    }
    CANONICAL_TERMS {
        uuid term_id PK
        canonical_category category
        text canonical_name
        text match_key
        canonical_status status
        uuid merged_into_id FK "nullable"
        timestamptz created_at
    }
    ALIASES {
        uuid alias_id PK
        uuid term_id FK
        text alias_text
        text match_key
        alias_scope scope
        alias_origin origin
        alias_status status
        timestamptz created_at
    }
    NORMALIZATION_DECISIONS {
        uuid normalization_id PK
        uuid claim_id FK
        uuid term_id FK "nullable"
        text original_value
        normalization_method method "nullable"
        numeric confidence_score "nullable"
        actor_type actor_type
        text rule_version
        normalization_status status
        timestamptz created_at
    }
    CLAIM_REVISIONS {
        uuid revision_id PK
        uuid claim_id FK
        jsonb previous_values
        timestamptz created_at
    }
    DOCUMENTS {
        uuid document_id PK
        uuid owner_user_id FK
        document_purpose purpose
        text original_filename
        text media_type
        bigint byte_size
        text sha256
        text storage_key UK
        document_status status
        text failure_code "nullable"
        timestamptz created_at
        timestamptz updated_at
    }
    DOCUMENT_EXTRACTIONS {
        uuid extraction_id PK
        uuid document_id FK, UK
        extraction_status status
        document_format format
        integer page_count "nullable"
        jsonb content
        jsonb failures
        jsonb unmapped_data
        text parser_version
        timestamptz created_at
        timestamptz updated_at
    }
    DOCUMENT_PROCESSING_JOBS {
        uuid job_id PK
        uuid document_id FK
        processing_job_status status
        integer attempt_count
        text failure_code "nullable"
        timestamptz available_at
        timestamptz locked_until "nullable"
        timestamptz created_at
        timestamptz updated_at
    }
    LLM_INVOCATIONS {
        uuid invocation_id PK
        uuid operation_id
        text task
        text provider
        text model
        text prompt_version
        integer contract_version
        llm_invocation_status status
        text provider_request_id "nullable"
        integer input_tokens "nullable"
        integer output_tokens "nullable"
        text error_category "nullable"
        text error_code "nullable"
        timestamptz started_at
        timestamptz completed_at "nullable"
    }

    USERS ||--|| AUTH_TOKEN_VERSIONS : owns
    USERS ||--o| CANDIDATES : "has profile"
    USERS ||--o{ DOCUMENTS : owns
    DOCUMENTS ||--o| DOCUMENT_EXTRACTIONS : "extracted into"
    DOCUMENTS ||--o{ DOCUMENT_PROCESSING_JOBS : schedules
    CANDIDATES ||--o{ CLAIMS : has
    CLAIMS ||--o| SKILL_DETAILS : "type skill"
    CLAIMS ||--o| EMPLOYMENT_DETAILS : "type employment"
    CLAIMS ||--o| EDUCATION_DETAILS : "type education"
    CLAIMS ||--o| CERTIFICATION_DETAILS : "type certification"
    CLAIMS ||--o| LANGUAGE_DETAILS : "type language"
    CLAIMS ||--o| PROJECT_DETAILS : "type project"
    CLAIMS ||--o{ CLAIM_REVISIONS : archives
    CLAIMS ||--o{ NORMALIZATION_DECISIONS : "normalized in"
    CANONICAL_TERMS ||--o{ ALIASES : "written as"
    CANONICAL_TERMS ||--o{ NORMALIZATION_DECISIONS : "chosen in"
```

## Users

Owned by the `users` module and defined in
`src/modules/users/users.table.ts`.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `user_id` | UUID | Primary key, generated | Stable user identifier |
| `name` | Text | Required, nonblank | Display name |
| `email` | Text | Required, normalized, case-insensitively unique | Normalized sign-in/contact address |
| `password_hash` | Text | Nullable | Password-derived credential; never returned by the API |
| `role` | `user_role` | Required, defaults to `candidate` | Authorization category |
| `account_status` | `account_status` | Required, defaults to `active` | Account lifecycle state |
| `email_verified_at` | Timestamp with time zone | Nullable | Email verification time |
| `created_at` | Timestamp with time zone | Required, generated | Creation time |
| `updated_at` | Timestamp with time zone | Required, generated | Last update time |

### Enumerations

- `user_role`: `candidate`, `reviewer`, `admin`
- `account_status`: `active`, `suspended`, `disabled`

## Authentication token versions

Owned by the `auth` module and defined in
`src/modules/auth/auth.table.ts`.

`auth_token_versions` stores one nonnegative version per user. Each 15-minute
access JWT includes the version that was current when it was issued. Guards
compare the JWT claim with this table on every authenticated request. Logout,
password changes, and security-sensitive account actions increment the stored
version, invalidating every previously issued JWT. The row cascades on user
deletion.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `user_id` | UUID | Primary key, user FK, cascade delete | Token owner |
| `version` | Integer | Required, nonnegative, defaults to `0` | Current valid JWT version |
| `updated_at` | Timestamp with time zone | Required, generated | Last invalidation time |

## Candidates

Owned by the `candidates` module and defined in
`src/modules/candidates/candidates.table.ts`.

`candidates` stores one profile per user with the candidate's personal
information. The email address is not duplicated; it is read from the user
through the users service. The row cascades on user deletion.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `candidate_id` | UUID | Primary key, generated | Stable profile identifier |
| `user_id` | UUID | Required, unique, user FK, cascade delete | Profile owner |
| `full_name` | Text | Required, nonblank | Name shown on the profile |
| `headline` | Text | Nullable | Professional title, such as "Backend Developer" |
| `summary` | Text | Nullable | Professional summary |
| `phone` | Text | Nullable | Contact phone number |
| `location` | Text | Nullable | Candidate location |
| `contact_email` | Text | Nullable, valid email | Email shown on the CV and profile; can differ from the account email |
| `profile_links` | JSONB | Required, defaults to `[]` | `{ label, url }` links such as LinkedIn or GitHub |
| `version` | Integer | Required, defaults to `1` | Increases on every update; an edit sent with an older version in `If-Match` is refused |
| `created_at` | Timestamp with time zone | Required, generated | Creation time |
| `updated_at` | Timestamp with time zone | Required, generated | Last update time |

## Claims

Owned by the `candidates` module.

A claim is one piece of profile information: a skill, an employment record,
an education record, a certification, a language, or a project. Claims entered
by the candidate are stored as `manual` and `accepted`. Only accepted claims
appear in the exported profile; pending and rejected claims are excluded.
Claims cascade on profile deletion.

Creating a claim and its type-specific details is atomic. The candidates
repository can join a caller-owned transaction, allowing extraction to save
multiple claims and document `unmapped_data` as one unit; manual creation uses
its own transaction with transient-failure retries.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `claim_id` | UUID | Primary key, generated | Stable claim identifier |
| `candidate_id` | UUID | Required, candidate FK, cascade delete, indexed | Claim owner |
| `claim_type` | `claim_type` | Required | Kind of profile information |
| `origin` | `claim_origin` | Required | Whether the candidate entered or extraction produced the claim |
| `status` | `claim_status` | Required, defaults to `pending` | Review state; only `accepted` is exported |
| `extraction_invocation_id` | UUID | Required for extracted claims; null for manual claims | LLM invocation that produced the draft |
| `extraction_document_id` | UUID | Required on new extracted claims; nullable for legacy rows; null for manual claims | Source document that produced the draft |
| `extraction_raw_values` | JSONB | Required for extracted claims; null for manual claims | Original wording for normalized fields |
| `extraction_field_sources` | JSONB | Required for extracted claims; null for manual claims | AI-input references supporting each field |
| `extraction_current` | Boolean | Required for extracted claims; null for manual claims | Whether the source explicitly described the claim as current |
| `version` | Integer | Required, defaults to `1` | Increases on every value change; an edit or delete sent with an older version in `If-Match` is refused |
| `created_at` | Timestamp with time zone | Required, generated | Creation time |
| `updated_at` | Timestamp with time zone | Required, generated | Last value change |

`extraction_document_id` is intentionally not a foreign key until document
deletion semantics for reviewed claims are defined. New application writes
always provide it; older extracted claims remain readable with a null value.

## Claim details

Owned by the `candidates` module.

Each claim has exactly one details row, stored in the table that matches its
`claim_type`. The details table uses `claim_id` as both its primary key and its
claim foreign key, and rows cascade on claim deletion. Real columns, rather
than generic JSON values, let profile search query and index claim data
directly, such as finding candidates with a given skill.

The API exchanges dates as `YYYY-MM`. The database stores them as `date` values
on the first day of the month, so durations can be calculated and records can
be sorted by date. Optional fields are omitted from API values when empty.

### `skill_details`

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `claim_id` | UUID | Primary key, claim FK, cascade delete | Owning claim |
| `name` | Text | Required, indexed case-insensitively | Skill name |

### `employment_details`

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `claim_id` | UUID | Primary key, claim FK, cascade delete | Owning claim |
| `employer` | Text | Required | Employer name |
| `job_title` | Text | Required | Job title |
| `start_date` | Date | Required | First month of employment |
| `end_date` | Date | Nullable, not before `start_date` | Last month; null for a current role |
| `location` | Text | Nullable | Work location, such as "Remote" |
| `description` | Text | Nullable | Role description |
| `skills` | Text array | Required, defaults to empty, GIN indexed | Skills used in the role |

### `education_details`

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `claim_id` | UUID | Primary key, claim FK, cascade delete | Owning claim |
| `institution` | Text | Required | Educational institution |
| `degree` | Text | Required | Degree, such as "BSc" |
| `field_of_study` | Text | Nullable | Field of study |
| `start_date` | Date | Required | First month of study |
| `end_date` | Date | Nullable, not before `start_date` | Last month; null while studying |

### `certification_details`

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `claim_id` | UUID | Primary key, claim FK, cascade delete | Owning claim |
| `title` | Text | Required | Certificate title |
| `issuer` | Text | Required | Issuing organization |
| `issue_date` | Date | Required | Issue month |
| `expiry_date` | Date | Nullable, not before `issue_date` | Expiry month |
| `credential_id` | Text | Nullable | Issuer credential identifier |

### `language_details`

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `claim_id` | UUID | Primary key, claim FK, cascade delete | Owning claim |
| `name` | Text | Required | Language, such as "English" |
| `proficiency` | Text | Nullable | Level as written, such as "Native" or "C1"; one scale is left to normalization |

### `project_details`

Many CVs list projects without dates, so both dates are optional.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `claim_id` | UUID | Primary key, claim FK, cascade delete | Owning claim |
| `name` | Text | Required | Project name |
| `description` | Text | Nullable | What the project does |
| `role` | Text | Nullable | The candidate's role, such as "Backend developer" |
| `url` | Text | Nullable, valid URL | Project or repository link |
| `start_date` | Date | Nullable | First month of the project |
| `end_date` | Date | Nullable, not before `start_date` when both are set | Last month |
| `skills` | Text array | Required, defaults to empty, GIN indexed | Skills used in the project |

## Claim revisions

Owned by the `candidates` module.

Before a claim's details are edited, its previous values are archived in
`claim_revisions` in the API shape (camelCase fields, `YYYY-MM` dates). The
details tables therefore always hold current values, and the oldest revision of
an edited claim holds its original values. Unchanged edits create no revision.
Revisions are not searched and cascade on claim deletion.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `revision_id` | UUID | Primary key, generated | Stable revision identifier |
| `claim_id` | UUID | Required, claim FK, cascade delete, indexed | Edited claim |
| `previous_values` | JSONB | Required | Complete claim values before the edit |
| `created_at` | Timestamp with time zone | Required, generated | Edit time |

### Enumerations

- `claim_type`: `skill`, `employment`, `education`, `certification`,
  `language`, `project`
- `claim_origin`: `manual`, `extracted`
- `claim_status`: `pending`, `accepted`, `rejected`

## Normalization

Owned by the `normalization` module and defined in
`src/modules/normalization/normalization.table.ts`. See
[Normalization](../modules/normalization.md) for the design.

Normalization links a claim's value to a canonical term without changing the
claim. Values are compared by a match key: the text in NFKC form, trimmed, with
inner spaces collapsed and letters in lowercase; punctuation is kept.

### `canonical_terms`

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `term_id` | UUID | Primary key, generated | Stable term identifier |
| `category` | `canonical_category` | Required, unique with `match_key` | Kind of value the term names |
| `canonical_name` | Text | Required | The term as shown, such as "JavaScript" |
| `match_key` | Text | Required | Name used for matching |
| `status` | `canonical_status` | Required, defaults to `active` | Whether the term is used or was merged |
| `merged_into_id` | UUID | Nullable, canonical term FK, set null on delete | Term this one was merged into |
| `created_at` | Timestamp with time zone | Required, generated | Creation time |

### `aliases`

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `alias_id` | UUID | Primary key, generated | Stable alias identifier |
| `term_id` | UUID | Required, canonical term FK, cascade delete, unique with `match_key` | Term the alias writes |
| `alias_text` | Text | Required | Another way of writing the term, such as "JS" |
| `match_key` | Text | Required, indexed | Alias used for matching |
| `scope` | `alias_scope` | Required, defaults to `global` | Whether the alias applies to everyone |
| `origin` | `alias_origin` | Required | Where the alias came from |
| `status` | `alias_status` | Required, defaults to `pending` | Only `approved` aliases are used for matching |
| `created_at` | Timestamp with time zone | Required, generated | Creation time |

### `normalization_decisions`

Each normalization of a claim adds a row. The newest row of a claim is its
current decision; older rows are its history. A decision for an unchanged
value is not repeated.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `normalization_id` | UUID | Primary key, generated | Stable decision identifier |
| `claim_id` | UUID | Required, claim FK, cascade delete, indexed with `created_at` | Normalized claim |
| `term_id` | UUID | Nullable, canonical term FK, set null on delete | Chosen term; null when unmatched or ambiguous |
| `original_value` | Text | Required | The claim value that was normalized |
| `method` | `normalization_method` | Nullable | How the term was found; null when unmatched |
| `confidence_score` | Numeric(3, 2) | Nullable | `1` for an exact match; null otherwise |
| `actor_type` | `actor_type` | Required | Who decided; `system` for automatic matching |
| `rule_version` | Text | Required | Matching rules used, such as `exact-v1` |
| `status` | `normalization_status` | Required | `matched`, `unmatched`, or `ambiguous` |
| `created_at` | Timestamp with time zone | Required, generated | Decision time |

### Normalization enumerations

- `canonical_category`: `skill`, `job_title`, `degree`
- `canonical_status`: `active`, `merged`
- `alias_scope`: `global`, `candidate`
- `alias_origin`: `seed`, `ai`, `candidate`, `reviewer`
- `alias_status`: `pending`, `approved`, `rejected`
- `normalization_method`: `canonical`, `alias`, `fuzzy`, `ai`, `candidate`
- `normalization_status`: `matched`, `unmatched`, `ambiguous`
- `actor_type`: `system`, `ai`, `candidate`, `reviewer`

Values that the first version does not use are defined for the later matching
steps of the requirements.

## Documents

Owned by the `documents` module and defined in
`src/modules/documents/documents.table.ts`.

Documents store metadata for candidate-owned source and evidence files. The
file bytes remain in private storage and are addressed by an opaque, unique
storage key. Document rows cascade when their owning user is deleted.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `document_id` | UUID | Primary key, generated | Stable document identifier |
| `owner_user_id` | UUID | Required, user FK, cascade delete, indexed | Document owner |
| `purpose` | `document_purpose` | Required | Source or evidence classification |
| `original_filename` | Text | Required, nonblank | Client-visible original filename |
| `media_type` | Text | Required | Server-verified content type |
| `byte_size` | Bigint | Required, positive | Size of the original file in bytes |
| `sha256` | Text | Required, indexed with owner | SHA-256 checksum of the original bytes |
| `storage_key` | Text | Required, unique | Opaque storage identifier |
| `status` | `document_status` | Required, defaults to `stored` | Document lifecycle state |
| `failure_code` | Text | Nullable | Machine-readable processing failure |
| `created_at` | Timestamp with time zone | Required, generated, indexed with owner | Creation time |
| `updated_at` | Timestamp with time zone | Required, generated | Last lifecycle update |

### Document enumerations

- `document_purpose`: `source`, `evidence`
- `document_status`: `stored`, `processing`, `ready`, `failed`, `deleting`

## Document processing jobs

Owned by the `document-processing` module and defined in
`src/modules/document-processing/document-processing.table.ts`. See
[Asynchronous document processing](../modules/document-processing.md) for the
workflow design.

`document_processing_jobs` stores durable scheduling, retry, and lease state
for asynchronous parsing. A document may have multiple jobs over its lifetime,
but at most one active job (`queued`, `processing`, or `retrying`), enforced by
the partial unique index `document_processing_jobs_active_document_unique`.
The job ID is the idempotency key carried by queue messages, and
`attempt_count` identifies each claim of the job, so writes by an older attempt
are refused. Deleting a document deletes its processing history.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `job_id` | UUID | Primary key, generated | Stable job and message idempotency identifier |
| `document_id` | UUID | Required, document FK, cascade delete, indexed | Document to process |
| `status` | `processing_job_status` | Required, defaults to `queued`, indexed | Processing lifecycle state |
| `attempt_count` | Integer | Required, nonnegative, defaults to `0` | Number of processing attempts |
| `failure_code` | Text | Nullable | Machine-readable reason for a retry or terminal failure |
| `available_at` | Timestamp with time zone | Required, generated, indexed with status | Earliest time the job may run |
| `locked_until` | Timestamp with time zone | Nullable, indexed with status | Processing lease expiration |
| `created_at` | Timestamp with time zone | Required, generated | Creation time |
| `updated_at` | Timestamp with time zone | Required, generated | Last lifecycle update |

### Processing job enumeration

- `processing_job_status`: `queued`, `processing`, `retrying`, `completed`,
  `failed`

## LLM invocations

Owned by the shared LLM infrastructure and defined in
`src/infrastructure/llm/llm.table.ts`.

`llm_invocations` records safe metadata for each actual provider request.
`operation_id` groups retries for one logical feature action without creating
a foreign-key dependency on a processing job or feature table. Prompts,
document content, raw responses, credentials, and feature results are not
stored here.

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `invocation_id` | UUID | Primary key, generated | Stable identifier for one provider request |
| `operation_id` | UUID | Required, indexed | Groups provider requests for one logical action |
| `task` | Text | Required, indexed with start time | Feature-owned task name |
| `provider` | Text | Required, unique with a present provider request ID | Configured provider |
| `model` | Text | Required | Configured provider model |
| `prompt_version` | Text | Required | Feature-owned prompt version |
| `contract_version` | Integer | Required, positive | Feature output contract version |
| `status` | `llm_invocation_status` | Required, defaults to `started` | Provider-call lifecycle state |
| `provider_request_id` | Text | Nullable, unique per provider when present | Provider-side request identifier |
| `input_tokens` | Integer | Nullable, nonnegative | Provider-reported input token count |
| `output_tokens` | Integer | Nullable, nonnegative | Provider-reported output token count |
| `error_category` | Text | Nullable | Safe application error category |
| `error_code` | Text | Nullable | Safe provider or application error code |
| `started_at` | Timestamp with time zone | Required, generated | Request start time |
| `completed_at` | Timestamp with time zone | Nullable, not before start | Request completion time |

### LLM invocation enumeration

- `llm_invocation_status`: `started`, `succeeded`, `failed`

### Not yet implemented

The [target domain ERD](erd.md) includes claim details that belong to later
features and are intentionally not part of the current schema:

- `claims.confidence_score`, `claims.matched_claim_id`, and
  `claims.match_status` arrive only when review prioritization and duplicate
  matching have a concrete consumer. Model confidence remains transient.
- Field-level validation flags for low-confidence extracted values, previously
  modeled as `ClaimValueHistory.validation_status`, are left to the extraction
  review feature to place.
- `source_occurrences`, which links extracted claims to their source document
  and location, arrives with document upload and parsing. Exported claims
  already include an empty `sources` array for these references.

## Document extractions

Owned by the `parsing` module and defined in
`src/modules/parsing/parsing.table.ts`. See
[Document parsing](../modules/parsing.md) for the design.

`document_extractions` stores the text extracted from one source document.
PDF results keep pages, layout regions, lines, and on-page coordinates; DOCX
results keep ordered paragraph and table blocks. Parsing a document again
replaces its row. Deleting a document deletes its extraction.

```mermaid
erDiagram
    DOCUMENT_EXTRACTIONS {
        uuid extraction_id PK
        uuid document_id FK, UK
        extraction_status status
        document_format format
        integer page_count "nullable"
        jsonb content
        jsonb failures
        jsonb unmapped_data
        text parser_version
        timestamptz created_at
        timestamptz updated_at
    }
```

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `extraction_id` | UUID | Primary key, generated | Stable extraction identifier |
| `document_id` | UUID | Required, unique, document FK, cascade delete | Parsed document |
| `status` | `extraction_status` | Required | Whether every page, some pages, or nothing was extracted |
| `format` | `document_format` | Required | Parsed file format |
| `page_count` | Integer | Nullable, positive | PDF page count; null for DOCX or unopened files |
| `content` | JSONB | Required | `{ version, pages, blocks }`, described below |
| `failures` | JSONB | Required, defaults to `[]` | Failed pages or file with an error code, such as `NO_TEXT_LAYER` or `UNSUPPORTED_LANGUAGE` |
| `unmapped_data` | JSONB | Required, defaults to `[]` | Information outside the profile schema, such as courses or awards, or items that could not become claims; filled by the AI-output mapping |
| `parser_version` | Text | Required | Library and version that produced the result |
| `created_at` | Timestamp with time zone | Required, generated | First extraction time |
| `updated_at` | Timestamp with time zone | Required, generated | Latest extraction time |

### Enumerations

- `extraction_status`: `succeeded`, `partial`, `failed`
- `document_format`: `pdf`, `docx`

### Content shape

`content.version` is `3`. Code that reads `content` checks the version, so
results saved in an older shape can be told apart.

- `pages` (PDF; empty for DOCX): each page has `pageNumber`, `width`,
  `height`, and ordered `regions`.
  - A region has `index` (from 0), `box`, `confidence` (the score of the split
    that created it, or `null` when not split), and ordered `lines`.
  - A line has `order` (reading order across the whole document, unique, from
    1), `text`, `box`, `heading`, `bold`, `italic`, `bullet`, and `links`.
  - A `box` is `{ x, y, width, height }` in PDF points from the page's
    top-left corner.
- `blocks` (DOCX; empty for PDF): ordered blocks with an `index`.
  - A paragraph has `text`, `heading`, `bold`, `italic`, and `links`.
  - A table has `columns` (the header row when Word marks one, else `null`)
    and `rows`, each a list of cell texts.

### Unmapped data shape

Each item in `unmapped_data` has a `label` (the CV section or field, such as
"Courses & Certifications"), the `text`, its `sources` as AI-input line
references (such as `L12` or `B3`), and a `reason`, such as
`unsupported_section` or `missing_start_date`. The parser does not fill it, and
parsing a document again does not clear it yet; that is decided with the
AI-output mapping.

## Maintenance rules

- Keep physical column details aligned with the owning Drizzle table.
- Show foreign-key cardinality in the ER diagram when relationships are added.
- Record the business meaning of relationships and important constraints here.
- Update the target domain ERD when requirements change its entities or
  relationships; update this document only when the implemented schema changes.
- Use migrations for database evolution; do not treat this document as an
  executable schema.
