# PDF heading detection approach

## Goal

Identify document titles, section headings, uncertain heading candidates, and
body lines without treating every bold or large line as a heading.

## Output

```ts
type LineRole = 'document-title' | 'heading' | 'heading-candidate' | 'body';

interface HeadingAssessment {
  role: LineRole;
  confidence: number;
}
```

## Processing flow

1. Build complete text lines from PDF text pieces.
2. Calculate typical body height per page or layout region.
3. Normalize each complete line for vocabulary matching.
4. Exclude obvious non-heading lines.
5. Score the remaining lines using text and layout signals.
6. Assign a line role and confidence.
7. Use confirmed headings for section splitting.
8. Include confirmed and candidate headings in AI input.

## Normalization

```ts
function normalizeHeading(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[.:|]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
```

Match the entire normalized line, never individual words or substrings.

## Common heading vocabulary

Group variants under canonical sections:

- Profile: `about me`, `profile`, `summary`, `professional summary`, `objective`
- Contact: `contact`, `contact details`, `personal details`
- Education: `education`, `academic background`, `qualifications`
- Experience: `experience`, `work experience`, `professional experience`,
  `employment history`, `work history`
- Skills: `skills`, `technical skills`, `core competencies`, `competencies`
- Other: `projects`, `certifications`, `licenses`, `courses`, `relevant courses`,
  `training`, `languages`, `awards`, `achievements`, `publications`,
  `volunteering`, `interests`, `references`, `additional information`

Keep this vocabulary in one exported constant so variants can be added safely.

## Early exclusions

Reject a line as a heading candidate when it is:

- a bullet item;
- a date, email, phone number, or URL;
- a long sentence;
- longer than 60 characters;
- empty after normalization.

## Scoring

| Signal | Score |
| --- | ---: |
| Exact common-heading match | +0.50 |
| Larger than local body text | +0.20 |
| Bold | +0.10 |
| Uppercase or title case and short | +0.10 |
| Large vertical gap above | +0.10 |
| Matches repeated heading style | +0.10 |
| Long sentence | -0.40 |
| Date or contact value | -0.40 |
| Bullet item | -0.30 |
| Key/value line such as `GPA 3.71` | -0.30 |

Clamp the final confidence to `0..1`.

## Classification

| Confidence | Role |
| ---: | --- |
| `>= 0.70` | `heading` |
| `>= 0.45` | `heading-candidate` |
| `< 0.45` | `body` |

Detect the candidate name and professional title separately as
`document-title`; do not use them as section boundaries.

## Layout behavior

- Split sections only at confirmed headings.
- Do not split at heading candidates.
- Preserve heading status when a value appears on the same visual row.
- Prefer local body height over one document-wide height.
- Keep the existing conservative behavior when signals disagree.

## AI input

```text
## L11 EDUCATION
[section-candidate] L21 PROFESSIONAL EXPERIENCE
```

Include confidence only when useful for uncertain structure. Keep coordinates,
font names, and raw scoring details out of AI input.

## Tests

- Slightly larger bold uppercase section title is detected.
- Known heading matches even when its size increase is small.
- `Bachelor of Education` does not match `education`.
- Bold job titles remain body lines.
- `GPA 3.71` is not a confirmed heading.
- Contact values and bullet items are not headings.
- Multi-line headings remain joinable.
- Existing layout, reading-order, and AI-input tests continue to pass.
