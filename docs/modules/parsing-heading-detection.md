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
5. Score a first pass with weak repetition among heading-shaped lines.
6. Establish reliable section-style anchors from exact common names, intrinsic
   evidence, and the weak first-pass repetition.
7. Score a second pass using only styles that match those anchors; this trusted
   repetition replaces the weak first-pass repetition.
8. Assign a line role and confidence.
9. Use confirmed headings for section splitting.
10. Include confirmed and candidate headings in AI input.

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
| Exact common-heading match | +0.40 |
| Larger than local body text | +0.20 |
| Bold | +0.10 |
| Uppercase or title case and short | +0.10 |
| Large vertical gap above | +0.10 |
| First-pass raw style match | +0.05 each |
| Second-pass trusted style match | +0.10 each |
| Long sentence | -0.40 |
| Date value | -0.45 |
| Contact value | -0.50 |
| Bullet item | -0.35 |
| Number-dominant line such as `GPA 3.71` | -0.25 |

Cap combined negative heading evidence at `-0.65`, then clamp the final
confidence to `0..1`. This lets independent negative signals reinforce one
another without counting a phone number that is also numeric as an unlimited
penalty. A line is number-dominant when at least half of its whitespace-delimited
tokens contain a digit, so a heading such as `Top 10 Achievements` is not
penalized.

Both repetition passes use one `+0.35` cap. The final score uses the trusted
second-pass value instead of adding both passes. A non-common line needs at
least `0.50` intrinsic section evidence before weak repetition can help it
establish a style, so ordinary bold lines cannot confirm one another through
repetition alone. A repeated match requires the same font style
(bold, italic, and font height), left alignment, and letter-capping pattern
(uppercase, lowercase, title case, or mixed case).
Lines with negative heading evidence cannot earn repeated-style evidence or
become first-pass style anchors.

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
