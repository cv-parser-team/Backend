# AI-output mapping plan (V1)

## Goal

The AI reads the compact text that parsing builds from a CV and returns what it
found as JSON. This module checks that JSON and turns every valid item into a
pending extracted claim draft, keeping the original values and the lines they
came from. Invalid or incomplete items are kept as unmapped instead of being
rejected or completed with invented values.

V1 does not call an AI, save drafts, normalize values, or resolve conflicts.
It is tested with hand-written AI outputs.

## Input: the AI output contract

```json
{
  "version": 1,
  "profile": {
    "fullName": { "value": "Emma Carter", "sources": ["L1"] },
    "headline": { "value": "Backend Developer", "sources": ["L2"] },
    "contactEmail": { "value": "emma@example.com", "sources": ["L3"] },
    "links": [
      {
        "value": "https://www.linkedin.com/in/emma",
        "raw": "LinkedIn",
        "sources": ["L4"]
      }
    ]
  },
  "claims": [
    {
      "type": "employment",
      "confidence": 0.92,
      "fields": {
        "jobTitle": { "value": "Backend Developer", "sources": ["L10"] },
        "employer": { "value": "Example Corp", "sources": ["L10"] },
        "startDate": { "value": "2023-10", "raw": "Oct 2023", "sources": ["L11"] },
        "endDate": { "current": true, "raw": "Present", "sources": ["L11"] },
        "description": { "value": "Built REST APIs for payments.", "sources": ["L12-13"] },
        "skills": { "value": ["Node.js", "PostgreSQL"], "sources": ["L12-13"] }
      }
    },
    {
      "type": "language",
      "confidence": 0.98,
      "fields": {
        "name": { "value": "English", "sources": ["L40"] },
        "proficiency": { "value": "Native", "sources": ["L40"] }
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
- Each item in `claims` has a `type`, a `confidence` from 0 to 1, and its
  `fields`. The types and fields are those of the profile's claims:

| Type | Required fields | Optional fields |
| --- | --- | --- |
| `skill` | `name` | |
| `employment` | `employer`, `jobTitle`, `startDate` | `endDate`, `location`, `description`, `skills` |
| `education` | `institution`, `degree`, `startDate` | `fieldOfStudy`, `endDate` |
| `certification` | `title`, `issuer`, `issueDate` | `expiryDate`, `credentialId` |
| `language` | `name` | `proficiency` |
| `project` | `name` | `description`, `role`, `url`, `startDate`, `endDate`, `skills` |

- Every field has `sources`: the AI-input line references it came from, such as
  `L12`, `L5-7`, `L39-41,44`, or `B3` and `B4.1` for DOCX. A value without
  sources is invalid.
- `raw` keeps the text as the CV wrote it, such as `Oct 2023`.
- `unmapped` holds information the AI found that has no place in the profile,
  such as courses or awards.

## Mapping rules

| Situation | Result |
| --- | --- |
| Valid item | A pending extracted claim draft |
| Required field missing | Unmapped, reason `missing_<field>`, such as `missing_start_date` |
| Date not `YYYY-MM`, such as `2021` | Unmapped, reason `invalid_date`; no month is invented |
| End date written as `Present` | `current: true`; the end date stays empty |
| End date before start date | Unmapped, reason `invalid_date_order` |
| Field too long, empty, or the wrong kind | Unmapped, reason `invalid_value` |
| Unknown type or broken item | Unmapped, reason `invalid_item` |
| Invalid profile field, such as a bad email | That field is unmapped, reason `invalid_value`; the other fields stay |
| Profile link without its link text | That link is unmapped, reason `missing_label` |
| Profile that does not follow the contract | The whole profile is unmapped, reason `invalid_item`, keeping its text |
| Item in the AI's own `unmapped` list | Kept as unmapped, reason `unsupported_section` |
| Wrong `version` or no `claims` list | The whole output is rejected with `INVALID_AI_OUTPUT` |

- Each item is checked on its own, so one invalid item never rejects the others.
- Claim values are checked with the same rules as manual claims, so every
  draft can become a real claim.
- Optional fields that are empty are left out. Nothing missing is filled in.

## Output

```json
{
  "version": 1,
  "profile": {
    "values": { "fullName": "Emma Carter", "contactEmail": "emma@example.com" },
    "rawValues": {},
    "sources": { "fullName": ["L1"], "contactEmail": ["L3"] }
  },
  "claims": [
    {
      "type": "employment",
      "origin": "extracted",
      "status": "pending",
      "confidence": 0.92,
      "current": true,
      "values": {
        "employer": "Example Corp",
        "jobTitle": "Backend Developer",
        "startDate": "2023-10",
        "description": "Built REST APIs for payments.",
        "skills": ["Node.js", "PostgreSQL"]
      },
      "rawValues": { "startDate": "Oct 2023", "endDate": "Present" },
      "sources": ["L10", "L11", "L12-13"],
      "fieldSources": {
        "employer": ["L10"],
        "jobTitle": ["L10"],
        "startDate": ["L11"],
        "endDate": ["L11"],
        "description": ["L12-13"],
        "skills": ["L12-13"]
      }
    }
  ],
  "unmapped": [
    {
      "label": "education",
      "text": "BSc Computer Science; Sample University; 2021",
      "sources": ["L20", "L21"],
      "reason": "invalid_date"
    }
  ]
}
```

- `claims` are drafts with `origin: extracted` and `status: pending`, each with
  its `confidence`, all its `sources`, and the sources of each field.
- `rawValues` keep the text as the CV wrote it for fields that had a `raw`
  text, such as `Oct 2023` or `Present`, so original values are never lost.
- An unmapped item keeps the CV's own wording: a field's `raw` text when given,
  otherwise its value.
- `unmapped` items have the shape of `document_extractions.unmapped_data`, so
  they can be stored there later.

## Version 2

Listed under "Revisit later" on the task:

- Save drafts as candidate claims and unmapped items in `unmapped_data`.
- Resolve line references into `source_occurrences` with page and position.
- Store confidence and original extracted values on claims.
- Check that every line reference exists in the document's AI input.
- Avoid duplicate claims when an extraction runs again, and decide whether a
  new parse clears old unmapped data.
- Connect an AI provider and send it this contract.
- Normalize aliases and detect conflicts.
- Accept year-only dates and grades.
