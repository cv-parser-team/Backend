# AI-output mapping plan (V1)

## Goal

The AI reads the compact text that parsing builds from a CV and returns what it
found as JSON. This module checks that JSON and turns every valid item into a
pending extracted claim draft, keeping the original values, the lines they
came from, and how confident the AI was about each value. Invalid or
incomplete values are kept as unmapped instead of being rejected or completed
with invented values.

V1 does not call an AI, save drafts, normalize values, or resolve conflicts.
It is tested with hand-written AI outputs.

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
| Optional date not `YYYY-MM`, such as an end date of `2023` | Only that field unmapped, reason `invalid_date`; no month is invented |
| End date written as `Present` | `current: true`; the end date stays empty |
| End date before start date | Only the end date unmapped, reason `invalid_date_order` |
| Optional field too long, empty, or not part of the type | Only that field unmapped, reason `invalid_value` |
| Optional field with `raw` text but no value | Only that field unmapped, reason `missing_value` |
| Unknown type or broken item | Whole item unmapped, reason `invalid_item` |
| Invalid profile field, such as a bad email | Only that field unmapped, reason `invalid_value` |
| Profile link without its link text | Only that link unmapped, reason `missing_label` |
| Profile that does not follow the contract | Whole profile unmapped, reason `invalid_item`, keeping its text |
| Item in the AI's own `unmapped` list | Kept as unmapped, reason `unsupported_section` |
| Wrong `version` or no `claims` list | The whole output is rejected with `INVALID_AI_OUTPUT` |

- Each item is checked on its own, so one invalid item never rejects the others.
- Claim values are checked with the same rules as manual claims, so every
  draft can become a real claim.
- Nothing missing is filled in.
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
- `unmapped` items have the shape of `document_extractions.unmapped_data`, so
  they can be stored there later.

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
3. **Confidence stays in the AI output and the drafts; it is not stored in the
   database yet.** V1 saves nothing, and confidence only matters until the
   candidate reviews a claim. When drafts are saved, confidence is stored with
   the original extracted values, as the task lists them together.

## Version 2

Listed under "Revisit later" on the task:

- Save drafts as candidate claims and unmapped items in `unmapped_data`.
- Resolve line references into `source_occurrences` with page and position.
- Store confidence and original extracted values.
- Check that every line reference exists in the document's AI input.
- Avoid duplicate claims when an extraction runs again, and decide whether a
  new parse clears old unmapped data.
- Connect an AI provider and send it this contract.
- Normalize aliases and detect conflicts.
- Accept year-only dates and grades.
