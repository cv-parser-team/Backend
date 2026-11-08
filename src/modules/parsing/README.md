# Parsing module guide

This file is the fast path for changing `src/modules/parsing`. It describes the
implemented pipeline and the precedence rules that are easiest to miss when
working on layout bugs. The longer rationale lives in
[`docs/modules/parsing.md`](../../../docs/modules/parsing.md), and heading
scoring is described in
[`docs/modules/parsing-heading-detection.md`](../../../docs/modules/parsing-heading-detection.md).

## What this module owns

The module turns PDF or DOCX bytes into an `ExtractionResult`, persists one
result per document, and can render an HTML inspection report.

- PDF output is made of positioned pages, regions, and lines.
- DOCX output is made of ordered paragraph and table blocks. DOCX has no page
  geometry and does not use the PDF layout pipeline.
- `buildAiInput` derives compact, referenced text from stored output. It may
  join strongly supported wrapped lines, but it never changes stored lines.
- Meaning extraction, claims, OCR, and Arabic reconstruction are outside this
  module.

## Source-of-truth precedence

Use these sources in this order when investigating existing behavior:

1. Public data contracts and invariants in `parsing.types.ts` and
   `parsing.table.ts`.
2. Focused tests beside each pipeline stage. Tests describe behavior that must
   remain stable.
3. The current stage implementation and its exported settings/constants.
4. This README as a navigation and decision guide.
5. `docs/modules/parsing*.md` for design rationale and planned behavior.

If these disagree, do not silently choose one. Determine whether the code has
drifted from the intended design, then update the implementation, focused
tests, and relevant documentation together. Generated
`*.pdf.parsing.html`/`*.docx.parsing.html` files are inspection output, not a
specification and not an edit target.

## End-to-end flow

```text
parsing service
  -> parser selected by exact media type
     -> PDF extraction                 OR DOCX HTML extraction
     -> language policy                   -> ordered blocks
     -> reconstruct PDF lines
     -> measure page geometry
     -> score boundary candidates
     -> propose macro layout zones
     -> establish section scopes
     -> resolve entries inside sections
     -> resolve final ownership and reading order
  -> save/upsert extraction
  -> optionally build compact AI input
```

The PDF orchestration order is explicit in `buildPagesInternal` in `layout.ts`.
Keep it visible there; do not introduce a second orchestration path.

### Stage map

| Concern | Primary file | Focused tests |
| --- | --- | --- |
| Service selection and persistence call | `parsing.service.ts` | `parsing.service.test.ts` |
| PDF loading, text/styles, links, drawn marks | `pdf-parser.ts` | `pdf-parser.test.ts`, `pdf-parser-failure.test.ts` |
| DOCX loading | `docx-parser.ts` | `docx-parser.test.ts` |
| DOCX HTML paragraphs/tables | `docx-html.ts` | `docx-html.test.ts` |
| Arabic threshold and removal | `language.ts` | `language.test.ts` |
| Piece-to-line reconstruction and page metrics | `layout.ts` | `layout.test.ts` |
| Heading/entry/boundary evidence | `boundary-candidates.ts` | `boundary-candidates.test.ts` |
| Provisional page bands and lanes | `macro-layout.ts` | `macro-layout.test.ts` |
| Confirmed section ownership | `section-scopes.ts` | `section-scopes.test.ts` |
| Repeated entry ownership | `entry-groups.ts` | `entry-groups.test.ts` |
| Unique regions and reading order | `final-layout.ts` | `final-layout.test.ts` |
| Compact model-facing text | `ai-input.ts` | `ai-input.test.ts` |
| Visual trace | `inspection-report.ts` | `inspection-report.test.ts` |

## Layout precedence rules

These rules matter more than an individual score or rectangle:

1. **Raw geometry is evidence, not ownership.** Gutters, whitespace bands,
   separators, and alignments produce candidates. They do not directly assign
   lines to final regions.
2. **Negative content evidence can block a visual guess.** Dates, contact
   values, bullets, sentences, and numeric metadata must not become headings
   merely because their typography is prominent.
3. **Document titles do not open sections.** A strong header/title score wins
   over a competing section interpretation.
4. **Confirmed sections precede entries.** Entry anchors are resolved only
   within confirmed section scopes. A recognized section label establishes its
   scope before entry evidence is considered inside it.
5. **Common section labels have the strongest semantic authority.** Exact,
   normalized whole-line matches may establish a section. Never use substring
   matching: `Bachelor of Education` is not the `Education` label.
6. **Persistent gutters constrain ownership.** A section stays lane-local
   unless there is sufficient evidence that it governs content across the
   gutter. Same-row section peers normally own independent lanes.
7. **Page-wide bands close earlier lanes.** A supported standalone heading can
   end parallel scopes above it. A same-row heading pair continues independent
   lane-local structure instead.
8. **Repeated structure outranks a lone bold label for entries.** Entry anchors
   need contextual/repeated evidence inside their section. Confirmed education
   and experience scopes may also use a guarded regular-font fallback when a
   title-sized, separated candidate has strong entry evidence and an associated
   date. Metadata is never an entry anchor.
9. **Entry groups are indivisible downstream.** Column validation must reject
   boundaries that cut an established entry group. Section-local column
   detection excludes entry-owned lines.
10. **Final ownership is authoritative.** `resolveFinalLayout` assigns every
    reconstructed line to exactly one region and lists it exactly once in that
    region's reading order. The runtime assertion is intentional.
11. **Stored text precedes model convenience.** Line joining, style markers,
    hidden-link annotation, and line references belong in `ai-input.ts`, not in
    stored line reconstruction.
12. **Prefer a missed split to a false split.** When evidence is insufficient,
    keep related text together and expose the uncertainty in the trace.

Within a final section, ownership is materialized in this order:

```text
entry groups
  -> accepted section-local column content excluding entry lines
  -> remaining direct section lines
  -> unclaimed header/independent components
```

Region output is then ordered with the page-one header first, followed by
groups top-to-bottom and left-to-right. A section heading is emitted before its
continuations and owned content. `TextLine.order` is assigned only after final
reading order is known and is unique across all successfully parsed pages.

## Failure and format rules

- Parser selection uses an exact media-type match. Unsupported types throw
  `UnsupportedDocumentTypeError`; no extraction is saved.
- PDFs over `MAX_PDF_PAGES` fail before pages are read.
- A password/open/language failure is file-level and returns no pages.
- `NO_TEXT_LAYER` and `PAGE_UNREADABLE` can be page-level for PDFs. Successful
  pages are retained and the result becomes `partial`; no successful pages
  means `failed`.
- DOCX conversion errors are `UNREADABLE`; empty content is `NO_TEXT_LAYER`.
- At or above `MAX_ARABIC_RATIO`, the entire file is
  `UNSUPPORTED_LANGUAGE`. Below it, Arabic fragments are removed before
  layout/block output.
- PDF `pageCount` is the source file's page count, including failed pages.
  DOCX `pageCount` is `null`.
- A reparse upserts by `documentId`. Changing stored JSON shape requires
  incrementing `EXTRACTION_CONTENT_VERSION` and considering existing readers.

## Non-negotiable invariants

- Coordinates are PDF points measured from the top-left.
- Reconstructed lines preserve extracted wording; `TextPiece` objects are
  transient and are not persisted.
- Every final PDF line has one owner, one global order number, and one position
  in its region's reading order.
- Confirmed section ownership cannot overlap. Provisional overlap is allowed
  only as diagnostic evidence.
- A heading is not also emitted as a bullet.
- Regions use zero-based indexes; AI references use `P`, `R`, and globally
  ordered `L` labels. DOCX references use `B` labels.
- Layout behavior must remain deterministic for identical input.
- Keep scoring thresholds and tunable geometry values near the stage that owns
  them; do not duplicate a threshold in a later stage to force an outcome.

## Efficient debugging workflow

Start with the smallest stage whose output is wrong:

1. Generate one report:

   ```bash
   npm run parsing:inspect -- "testResumes/example.pdf"
   ```

2. In the report, find the first incorrect stage: reconstructed lines,
   metrics, boundary candidates, layout zones, section scopes, entry groups,
   validated layout, final ownership, or revised AI input.
3. Add a minimal focused test at that stage. Prefer synthetic `LayoutLine`
   data for layout rules; add a binary fixture only when testing PDF/DOCX
   extraction behavior itself.
4. Change the earliest stage that lacks the required evidence. Do not patch a
   later reading-order stage to compensate for a wrong heading or scope.
5. Run the focused test, then all parsing tests and the build:

   ```bash
   npx vitest run src/modules/parsing/<stage>.test.ts
   npx vitest run src/modules/parsing
   npm run build
   ```

To regenerate every report in a directory:

```bash
npm run parsing:inspect:all -- testResumes
```

Reports are best used comparatively: inspect the earliest stage that changed,
not only the final colored regions. `revisedAiInputLines` in the trace shows
final layout ordering; `buildAiInput` additionally applies safe wrapping,
style markers, hidden links, and final global line references.

## Choosing where to make a change

| Symptom | Change first |
| --- | --- |
| Missing/wrong glyphs, font style, links, marks, separators | `pdf-parser.ts` |
| Pieces incorrectly merge into a line or duplicate | `layout.ts` |
| Heading/title/entry score is wrong | `boundary-candidates.ts` |
| Gutter or page band is missing/misclassified | `macro-layout.ts` |
| A heading owns the wrong lane or ends at the wrong place | `section-scopes.ts` |
| Job/project cards split at the wrong anchors | `entry-groups.ts` |
| Correct ownership but wrong region/read order | `final-layout.ts` |
| Stored output is correct but compact text joins/marks incorrectly | `ai-input.ts` |
| Paragraph/table interpretation is wrong | `docx-html.ts` |
| Status/failure code is wrong | format parser (`pdf-parser.ts` or `docx-parser.ts`) |

Before adding a new heuristic, search for an existing signal or normalized
helper. In particular, reuse `normalizeSemanticText`/`normalizeSectionKey`, the
page metrics, and candidate reasons. A new rule should identify the evidence
that enables it, the evidence that vetoes it, and a regression test showing
both the intended case and the nearest false positive.
