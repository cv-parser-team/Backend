# Candidate extraction (V1)

## Goal

The AI reads the compact text that parsing builds from a CV and returns what it
found as JSON. This module checks that JSON and turns every valid item into a
pending extracted claim draft, keeping the original values, the lines they
came from, and how confident the AI was about each value. Invalid or
incomplete values are kept as unmapped instead of being rejected or completed
with invented values.

V1 sends compact parsing input through the tracked LLM service and maps the
provider's structured output. Its persistence coordinator can atomically save
pending claim drafts and the document's unmapped data. It does not yet persist
profile drafts, normalize extracted values through the
[normalization module](normalization.md), or resolve conflicts. The
document-processing worker invokes extraction after a successful or partial
parse.

The candidate extraction workflow is the callable boundary for an already
parsed document. It runs provider extraction first, then passes the mapped
result to the persistence coordinator. Provider work therefore happens outside
the database transaction; only the final claim and `unmapped_data` writes are
atomic. The module composition factory assembles that workflow from the
database-backed candidate writer, parsing service, and `UnitOfWork`.
Standalone persistence owns that transaction. A larger workflow can instead
pass its existing database executor, allowing parsed content, claims, unmapped
data, and processing state to share one transaction without nesting another.

Re-extracting a document replaces only that candidate's pending extracted
claims from the same source document. Manual claims, reviewed claims, legacy
claims without document provenance, and claims from other documents are never
deleted. Replacement and insertion share one transaction, so failed insertion
restores the previous pending set. A newly extracted draft is not inserted when
the same document already has an accepted or rejected extracted claim with the
same type and formatting-equivalent values. The comparison normalizes Unicode,
letter casing, surrounding or repeated whitespace, field order, and string-array
order or duplicates. Punctuation and every persisted field remain significant,
so changed and new drafts stay pending. Alias and broader semantic matching are
deferred and never use parser-inferred headings.

Formatting-equivalent drafts within one provider result are coalesced before
insertion. The first draft supplies the persisted values and original wording;
field references and physical occurrences are merged without duplication, and
an explicit current marker is retained when any equivalent draft has it. This
prevents duplicate pending claims without inventing semantic equivalence.
An `anchorKey` identifies exactly one physical occurrence across the entire
provider result. If any drafts reuse a key for different anchor content,
persistence fails before pending claims are deleted instead of silently keeping
either location.

Candidates review a pending claim through
`PATCH /api/candidates/me/claims/:claimId/review`. Acceptance or rejection is a
terminal, version-guarded decision; confidence remains advisory and never
chooses the decision automatically.

The extraction service owns the versioned prompt and output contract. Provider,
model, timeout, and the LLM service are injected so the module does not create
infrastructure or read global configuration.

Provider generation uses a shallow schema for the stable envelope and item
containers. The detailed field contract and type-specific requirements stay in
the versioned prompt because the configured Gemini model rejects the complete
nested schema as too complex. Local mapping remains authoritative: it validates
each item independently, so one malformed provider item does not discard valid
items returned with it.

## Input: the AI output contract

```json
{
  "version": 1,
  "profile": {
    "fullName": { "value": "Emma Carter", "confidence": 0.99, "sources": ["L1"] },
    "headline": { "value": "Backend Developer", "confidence": 0.95, "sources": ["L2"] },
    "contactEmail": { "value": "emma@example.com", "confidence": 0.97, "sources": ["L3"] },
    "links": [
      {
        "value": "https://www.linkedin.com/in/emma",
        "raw": "LinkedIn",
        "confidence": 0.9,
        "sources": ["L4"]
      }
    ]
  },
  "claims": [
    {
      "type": "employment",
      "fields": {
        "jobTitle": { "value": "Backend Developer", "confidence": 0.95, "sources": ["L10"] },
        "employer": { "value": "Example Corp", "confidence": 0.95, "sources": ["L10"] },
        "startDate": {
          "value": "2023-10",
          "raw": "Oct 2023",
          "confidence": 0.9,
          "sources": ["L11"]
        },
        "endDate": { "current": true, "raw": "Present", "confidence": 0.9, "sources": ["L11"] },
        "description": {
          "value": "Built REST APIs for payments.",
          "confidence": 0.75,
          "sources": ["L12-13"]
        },
        "skills": {
          "value": ["Node.js", "PostgreSQL"],
          "confidence": 0.85,
          "sources": ["L12-13"]
        }
      }
    },
    {
      "type": "language",
      "fields": {
        "name": { "value": "English", "confidence": 0.98, "sources": ["L40"] },
        "proficiency": { "value": "Native", "confidence": 0.6, "sources": ["L40"] }
      }
    }
  ],
  "unmapped": [
    {
      "label": "Courses",
      "text": "Advanced Laravel (09/2022)",
      "sources": ["L45"]
    }
  ]
}
```

- `version` must be `1`.
- `profile` holds the candidate's personal fields: `fullName`, `headline`,
  `summary`, `phone`, `location`, `contactEmail`, and `links`.
- Each item in `claims` has a `type` and its `fields`. The types and fields are
  those of the profile's claims:

| Type | Required fields | Optional fields |
| --- | --- | --- |
| `skill` | `name` | |
| `employment` | `employer`, `jobTitle`, `startDate` | `endDate`, `location`, `description`, `skills` |
| `education` | `institution`, `degree`, `startDate` | `fieldOfStudy`, `endDate` |
| `certification` | `title`, `issuer`, `issueDate` | `expiryDate`, `credentialId` |
| `language` | `name` | `proficiency` |
| `project` | `name` | `description`, `role`, `url`, `startDate`, `endDate`, `skills` |

- Every field has:
  - `confidence`: how sure the AI is about this value, from 0 to 1;
  - `sources`: the AI-input line references it came from, such as `L12`,
    `L5-7`, `L39-41,44`, or `B3` and `B4.1` for DOCX.

  A value without confidence or sources is invalid.
- `raw` keeps the text as the CV wrote it, such as `Oct 2023`.
- `unmapped` holds information the AI found that has no place in the profile,
  such as courses or awards.

## Mapping rules

An invalid **optional** field is set aside on its own and the claim keeps its
other fields. An invalid or missing **required** field rejects the whole
claim, because a claim cannot exist without it.

| Situation | Result |
| --- | --- |
| Valid item | A pending extracted claim draft |
| Value with low confidence | Kept, with its confidence, so the candidate can review it |
| Required field missing | Whole claim unmapped, reason `missing_<field>`, such as `missing_start_date` |
| Required field invalid, such as a start date of `2021` or an empty name | Whole claim unmapped, reason `invalid_date` or `invalid_value` |
| Required field cites a reference absent from the supplied AI input | Whole claim unmapped, reason `invalid_source` |
| Optional date not `YYYY-MM`, such as an end date of `2023` | Only that field unmapped, reason `invalid_date`; no month is invented |
| End date written as `Present` | `current: true`; the end date stays empty |
| End date before start date | Only the end date unmapped, reason `invalid_date_order` |
| Optional field too long, empty, or not part of the type | Only that field unmapped, reason `invalid_value` |
| Optional field with `raw` text but no value | Only that field unmapped, reason `missing_value` |
| Optional or profile field cites a reference absent from the supplied AI input | Only that field unmapped, reason `invalid_source` |
| Unknown type or broken item | Whole item unmapped, reason `invalid_item` |
| Invalid profile field, such as a bad email | Only that field unmapped, reason `invalid_value` |
| Profile link without its link text | Only that link unmapped, reason `missing_label` |
| Profile that does not follow the contract | Whole profile unmapped, reason `invalid_item`, keeping its text |
| Item in the AI's own `unmapped` list | Kept as unmapped, reason `unsupported_section` |
| Item in the AI's own `unmapped` list cites an absent reference | Kept as unmapped, reason `invalid_source` |
| Wrong `version` or no `claims` list | The whole output is rejected with `INVALID_AI_OUTPUT` |

- Each item is checked on its own, so one invalid item never rejects the others.
- Claim values are checked with the same rules as manual claims, so every
  draft can become a real claim.
- Nothing missing is filled in.
- Source references must exactly match tokens present in the compact AI input;
  page/region headers and table column labels are not evidence references.
- A matching token establishes citation integrity only. Parser-inferred
  headings, section ownership, and region roles can be wrong and are not
  authoritative provenance. Reference resolution uses original PDF lines and
  coordinates or original DOCX blocks and table rows; semantic support remains
  subject to review.
- Before persistence, claim citations can be mapped into physical occurrence
  drafts. A draft combines repeated citations to the same stored line or DOCX
  row, retains every supporting claim field and reference token, and carries
  only physical evidence. Any missing or ambiguous anchor fails the mapping
  instead of silently losing provenance.
- An unmapped field is labelled with its claim type and field, such as
  `employment.endDate`.

## Output

```json
{
  "version": 1,
  "profile": {
    "values": { "fullName": "Emma Carter", "contactEmail": "emma@example.com" },
    "rawValues": {},
    "confidence": { "fullName": 0.99, "contactEmail": 0.97 },
    "sources": { "fullName": ["L1"], "contactEmail": ["L3"] }
  },
  "claims": [
    {
      "type": "employment",
      "origin": "extracted",
      "status": "pending",
      "confidence": 0.75,
      "fieldConfidence": {
        "jobTitle": 0.95,
        "employer": 0.95,
        "startDate": 0.9,
        "endDate": 0.9,
        "description": 0.75,
        "skills": 0.85
      },
      "current": true,
      "values": {
        "jobTitle": "Backend Developer",
        "employer": "Example Corp",
        "startDate": "2023-10",
        "description": "Built REST APIs for payments.",
        "skills": ["Node.js", "PostgreSQL"]
      },
      "rawValues": { "startDate": "Oct 2023", "endDate": "Present" },
      "sources": ["L10", "L11", "L12-13"],
      "fieldSources": {
        "jobTitle": ["L10"],
        "employer": ["L10"],
        "startDate": ["L11"],
        "endDate": ["L11"],
        "description": ["L12-13"],
        "skills": ["L12-13"]
      }
    }
  ],
  "unmapped": [
    {
      "label": "Courses",
      "text": "Advanced Laravel (09/2022)",
      "sources": ["L45"],
      "reason": "unsupported_section"
    }
  ]
}
```

The language claim from the input is also a draft, with a confidence of 0.6
taken from its proficiency. A field set aside on its own looks like this:

```json
{ "label": "education.endDate", "text": "2023", "sources": ["L22"], "reason": "invalid_date" }
```

- `claims` are drafts with `origin: extracted` and `status: pending`. Each has
  the confidence of every kept field, its overall `confidence`, all its
  `sources`, and the sources of each field.
- `rawValues` keep the text as the CV wrote it for fields that had a `raw`
  text, such as `Oct 2023` or `Present`, so original values are never lost.
- An unmapped item keeps the CV's own wording: a field's `raw` text when given,
  otherwise its value.
- `unmapped` items have the shape of `document_extractions.unmapped_data` and
  replace that field as the latest successful extraction snapshot. An empty
  result clears unmapped items from an older extraction.

## Decisions

1. **Confidence is given per field, not per claim.** The AI can be sure of a
   job title and unsure of its end date. Per-field confidence shows exactly
   which value the candidate should review, instead of doubting the whole
   claim.
2. **A claim's overall confidence is its lowest field confidence, not the
   average.** A claim is only as reliable as its weakest value. An average
   hides one doubtful field: three fields at 0.95 and one at 0.3 average 0.79,
   which looks safe. The overall value is only a summary for finding claims to
   review; the confidence of each field is kept. Fields that were set aside are
   left out.
3. **Confidence stays transient.** It is model-generated review guidance, not
   a candidate fact. Extracted claims persist their invocation, original
   wording, sources, source document, and explicit current status; confidence
   can be added when a review or evaluation feature has a concrete use for it.

## Version 2

Listed under "Revisit later" on the task:

- Detect near or semantic duplicates against accepted or rejected claims.
- Normalize aliases and detect conflicts.
- Accept year-only dates and grades.

## Manual inspection

With PostgreSQL migrated and `LLM_API_KEY` configured, run:

```bash
npm run llm:inspect
```

The command sends a deterministic referenced CV sample through the configured
provider, prints the mapped profile, pending claim drafts, unmapped items, and
invocation ID, and records the provider invocation in `llm_invocations`.
Extracted claims and `unmapped_data` are not written by this command yet; that
requires wiring the persistence coordinator into a workflow with a document
and candidate owner.

To inspect occurrences written by the document-processing worker, replace the
UUID and run this read-only query in PostgreSQL:

```sql
select
  c.claim_id,
  c.claim_type,
  c.status,
  so.anchor_key,
  so.source_references,
  so.field_names,
  so.anchor
from source_occurrences so
join claims c on c.claim_id = so.claim_id
where so.document_id = '00000000-0000-0000-0000-000000000000'::uuid
order by c.created_at, so.anchor_key;
```
