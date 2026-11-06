# Parser Revisited

## Purpose

Rework the deterministic PDF layout parser so it establishes likely document
relationships before it makes destructive region splits. The current pipeline
can find headings, columns, and entry anchors, but it may separate metadata
from the title or body it describes. Once those lines are placed in different
regions, the later ownership repair has too little information to reconstruct
the original entry reliably.

The revised parser remains geometry-first. It may recognize visual roles such
as a section heading, entry anchor, metadata, body text, or separator, but it
must not decide that a section means education, experience, skills, or another
CV concept. Semantic interpretation remains the responsibility of AI.

## Design principles

- Preserve every extracted line exactly once.
- Prefer an unsplit region over a confident-looking but destructive split.
- Treat headings, whitespace, columns, and drawn rules as evidence, not as
  absolute boundaries by themselves.
- Classify candidates globally, then resolve their roles in local context.
- Establish high-confidence relationships before splitting regions.
- Keep uncertainty visible through scores and trace data.
- Keep extraction facts separate from inferred layout relationships.
- Make every stage independently inspectable and testable.

## Recommended parsing stages

### 1. Extract PDF primitives

Read all available page-level evidence without assigning layout ownership:

- text pieces and their bounding boxes;
- font name, size, bold, and italic hints;
- hidden link annotations;
- small drawn marks that may be bullets;
- horizontal and vertical drawn separators;
- page width, height, and transforms.

Horizontal separators should be stored separately from bullet marks. Detect
both stroked paths and thin filled rectangles. A separator needs its position,
length, thickness, and orientation. It is evidence for a boundary, not a text
line and not an automatic split.

Output: `PagePrimitives`.

### 2. Reconstruct visual lines

Group compatible text pieces into visual lines. This stage handles only
piece-level reconstruction:

- merge pieces that share a baseline and normal word spacing;
- keep repeated lanes or large horizontal gaps as separate lines;
- restore spaced-out heading text when drawn text preserves the word breaks;
- remove duplicate overlaid text;
- attach links and nearby drawn bullets;
- retain line geometry and style evidence.

Do not classify headings, entries, sections, or columns yet.

Output: ordered `LayoutLine[]` in geometric page order.

### 3. Measure page statistics

Calculate the baselines used by later scoring:

- usual body-line height;
- usual vertical gap;
- common left and right edges;
- repeated X lanes;
- repeated row baselines;
- font-size and style clusters;
- candidate vertical gutters;
- candidate horizontal whitespace bands;
- separator coverage relative to the page and nearby lanes.

These values must be derived per page, with safe fallbacks for sparse pages.

Output: `PageMetrics`.

### 4. Generate scored boundary candidates

Classify possible boundaries without committing to them. Each line may receive
scores for:

- document-header boundary;
- section boundary;
- entry boundary;
- ordinary content.

Also generate non-text boundary candidates from:

- persistent vertical gutters;
- large horizontal whitespace bands;
- horizontal drawn separators;
- repeated alignment changes.

Keep the individual evidence behind each score. For example, a short bold line
may score as both a section and an entry candidate. It becomes a final role
only after its surrounding section and repeated entry pattern are known.

Output: `BoundaryCandidate[]` and annotated lines.

### 5. Generate provisional macro layout hypotheses

Identify possible page-level divisions supported by strong evidence, such as:

- a full-width header above the body;
- a full-width section between column groups;
- a persistent sidebar or independent column system;
- a horizontal rule or whitespace band spanning the relevant content width.

These hypotheses are non-destructive. A vertical gutter must not partition
lines into exclusive zones, establish ownership, or prevent later section and
entry analysis across the gutter. Lines may participate in more than one zone
hypothesis until section scopes and cross-gutter associations have been
evaluated.

Full-width horizontal boundaries with strong supporting evidence may limit
scope discovery. Vertical gutters remain provisional because they may separate
the metadata and body rails of one entry. This stage should avoid treating
ordinary entry rails, right-aligned dates, tables, reference cards, and skills
grids as confirmed macro divisions.

Output: `LayoutZoneCandidate[]` with confidence and evidence.

### 6. Establish section scopes

Using the provisional macro hypotheses, resolve section candidates with
contextual evidence:

- larger-than-body typography;
- repeated section-heading style;
- whitespace before or after the line;
- a nearby horizontal separator;
- lane continuity;
- competing candidates at the same row;
- the next confirmed section boundary.

A section scope starts at a confirmed section boundary and ends at the next
confirmed section boundary that governs the same lane or area. Section
resolution must consider lines across provisional vertical zone boundaries. A
section scope may span multiple lanes or zone candidates when a single heading
governs their content. A gutter alone cannot terminate a section scope.

Parallel scopes are confirmed only when each lane has independent section
evidence, such as separate headings, repeated lane-local structure, and no
strong cross-lane entry associations. A person name or job title must not
become a section solely because it is short, bold, and larger than body text.

Output: `SectionScope[]` with confidence and evidence.

### 7. Resolve entry candidates inside each section

Entry classification happens only inside a section scope. Look for repeated
visual patterns rather than isolated bold lines:

- repeated short anchors with the same style and lane;
- dates, organizations, locations, or contact values aligned with anchors;
- nearby body lines following the same direction;
- recurring gaps between entries;
- consistent anchor-to-body or metadata-to-body relationships;
- entry candidates that do not cross the section boundary.

Context may demote a preliminary section candidate to an entry anchor. This is
important for reference names and other larger bold labels inside a confirmed
section.

Output: resolved entry anchors and local entry evidence.

### 8. Build association hints and entry groups

Before any local column split, create non-destructive relationships among
lines. Useful association types include:

- `same-entry`;
- `anchor-metadata`;
- `anchor-body`;
- `metadata-body`;
- `wrapped-line`;
- `same-row-cell`;
- `section-content`.

Each association records its confidence and evidence. Evidence may include
row alignment, proximity, repeated layout pattern, matching lane, separator
placement, typography, and the absence of a competing local body.

Use these associations to form tentative entry groups. A common two-rail CV
entry should become one group even when its date and organization are on the
left and its title and description are on the right. Association hints should
not change the stored text or force a semantic interpretation.

Association discovery must evaluate plausible relationships across provisional
gutters and zone candidates. Cross-gutter relationships are especially
important for metadata rails, dates, organizations, titles, descriptions, and
reference-card fields. A zone hypothesis must not prevent an association from
being considered.

Entry groups form connected components for split validation. Their confidence
may be revised by contradictory evidence, but they remain intact unless that
contradictory evidence is stronger and recorded in the trace.

Output: `Association[]` and tentative `EntryGroup[]`.

### 9. Validate macro zones and perform constrained splitting

Resolve provisional macro zones and local column, section, table, grid, and
whitespace split candidates together, after section scopes, associations, and
entry groups are available. A candidate gutter split must be rejected when it
would:

- cut a high-confidence association;
- divide a resolved entry group;
- cause content governed by one confirmed section to lose that ownership;
- separate a wrapped paragraph;
- divide a shared-row table or unresolved grid.

A split may create separate visual regions while preserving a shared section
parent. Geometry and ownership are separate decisions: belonging to different
visual lanes must not by itself imply belonging to different sections.

A vertical split through a section is permitted only when either:

1. both resulting regions retain the same section ownership and no entry group
   or protected association is divided; or
2. strong independent evidence confirms genuinely parallel section scopes.

Weak associations may be broken by stronger contradictory evidence, but the
trace must show why. When split and association evidence remain ambiguous,
reject the split and keep the content together. Splitting remains recursive,
but it operates within already established scopes and constraints rather than
over the undifferentiated page.

Output: validated `LayoutZone[]` and constrained region drafts.

### 10. Resolve ownership and final region roles

Convert scopes, groups, and split drafts into final regions. Assign roles such
as:

- `independent` for the document header;
- `section` for a section heading and directly owned content;
- `entry` for a resolved entry group;
- `content` for supporting content that belongs to a parent section.

Set `parentIndex` only after final regions have stable indexes. Ownership
repair should operate on individual groups and associations, not only by
merging entire adjacent regions.

Output: final regions with role, parent, confidence, and lines.

### 11. Assign reading order

Order content only after ownership is stable:

1. page order;
2. macro zone order;
3. section order;
4. entry order inside the section;
5. anchor, metadata, then body inside an entry when ownership evidence supports
   that order;
6. geometric order as the fallback.

Reading order may differ from simple left-to-right geometry when a title rail
describes body text in another lane. Every line still receives one unique,
stable order number.

Output: stored `ParsedPage[]`.

### 12. Build compact AI input

Generate AI input from finalized regions and line references:

- preserve page, region, role, and parent markers;
- join wrapped lines conservatively;
- keep same-row cells together when they represent an unresolved grid;
- present linked entry fields together when deterministic ownership is strong;
- retain original `L` references for traceability.

This stage formats the result but must not repair layout mistakes that should
have been resolved earlier.

## Why this order

The critical dependency is:

```text
evidence
-> provisional layout hypotheses
-> cross-hypothesis section and entry reasoning
-> associations and entry groups
-> validated macro and local splits
-> ownership
```

Splitting before association discards the strongest clue that two lanes form
one entry. Conversely, forcing all sections before all column detection also
fails because some documents contain genuinely parallel sections. Macro layout
hypotheses therefore preserve strong page-level evidence without restricting
relationship discovery. Section and entry reasoning may cross those hypotheses,
and only then are macro and local splits validated. Gutters may propose
geometry, but they cannot constrain relationship discovery or decide ownership.

## Proposed internal contracts

The exact names may follow existing project conventions, but the model should
separate observations from inferences:

```ts
interface DrawnSeparator {
  orientation: 'horizontal' | 'vertical';
  box: BoundingBox;
  thickness: number;
}

interface ScoredEvidence {
  score: number;
  reasons: string[];
}

interface BoundaryCandidate {
  lineIndex: number;
  header: ScoredEvidence;
  section: ScoredEvidence;
  entry: ScoredEvidence;
}

type AssociationKind =
  | 'same-entry'
  | 'anchor-metadata'
  | 'anchor-body'
  | 'metadata-body'
  | 'wrapped-line'
  | 'same-row-cell'
  | 'section-content';

interface Association {
  kind: AssociationKind;
  lineIndexes: number[];
  confidence: number;
  reasons: string[];
}
```

Production output does not need to store all diagnostic evidence. The
inspection trace should keep it so thresholds can be tuned without guessing.

## Horizontal separator rules

A horizontal line contributes boundary evidence when:

- it is thin relative to the usual text height;
- it spans a meaningful share of the active zone or lane;
- it sits between text groups rather than through text;
- nearby headings or whitespace support the same boundary;
- it is not one of many repeated table borders.

Do not split solely because a rule exists. Underlines beneath names, decorative
accents, timelines, box borders, and table lines are common false positives.
Repeated parallel rules should be considered a table or card signal before a
section signal.

## Inspection report stages

The HTML inspection report should expose the revised pipeline in this order:

1. extracted primitives, including marks and separators;
2. reconstructed lines;
3. page metrics and candidate gutters/bands;
4. scored boundary candidates;
5. provisional macro layout hypotheses;
6. resolved section scopes;
7. entry candidates and association links;
8. validated macro zones and constrained split regions;
9. final ownership and reading order;
10. compact AI input.

Associations should be drawn as links or shared colors so a reviewer can see
why lines in different lanes remain together.

## Implementation sequence

Implement the redesign incrementally so each step has a measurable effect:

1. Add a separate separator primitive and extraction tests.
2. Extend the trace to display separators and scoring evidence.
3. Separate candidate heading scores from final layout actions.
4. Add provisional macro layout hypotheses without changing ownership or final
   region output.
5. Add section scopes that may cross provisional vertical gutters.
6. Add contextual section-to-entry demotion.
7. Add association hints across zone hypotheses and trace them without
   affecting splits.
8. Validate macro and local splits against high-confidence associations.
9. Build entry groups and group-level ownership repair.
10. Move reading-order assignment after final ownership.
11. Update AI input to use final roles and parents.
12. Compare all existing fixtures and real-CV inspection reports before
    removing the old split-first path.

Each step should preserve the existing public extraction contract unless a
versioned output-shape change is intentionally introduced.

## Tests and acceptance criteria

Every layout test must continue to prove:

- no line is lost;
- no line is duplicated;
- every line belongs to exactly one final region;
- every line order is unique and stable;
- region and line boxes remain inside the page.
- a provisional gutter never limits association discovery;
- a vertical gutter alone never terminates a section scope;
- no final split divides a resolved entry group;
- every final content and entry region retains its pre-split section ownership;
- separate visual regions may share one section parent;
- parallel section ownership requires positive evidence for independent
  scopes, not merely the absence of cross-lane associations;
- ambiguous gutter candidates remain unsplit.

Add focused cases for:

- entry metadata in a left rail with title and body in a right rail;
- the same layout with the rails reversed;
- two genuinely independent parallel sections;
- education entries with date, institution, degree, and description split
  across lanes;
- experience entries with dates and organizations beside titles and bodies;
- reference cards containing name, position, phone, and social details;
- a skills grid below an experience section that must not be absorbed into an
  experience entry;
- a horizontal rule between sections;
- an underline below a name that must not start a section;
- table borders that must not create sections;
- a decorative short rule that contributes little or no boundary score;
- contextual demotion of repeated reference names from section candidates to
  entry anchors.

The Arisha fixture is accepted when:

- each education date and university stays with its corresponding degree and
  description;
- each experience date and organization stays with its corresponding title and
  description;
- skill items belong to `SKILLS`, not to the final experience entry;
- both reference people are entries under `REFERENCES`;
- each reference person's phone and social details stay with that person;
- the AI input reflects these relationships without losing any `L` reference.

## Non-goals

- Determining the semantic type of a section.
- Extracting normalized claims from the CV.
- OCR or Arabic-layout support.
- Treating every grid as a table.
- Guaranteeing entry ownership when the page provides no geometric or repeated
  visual evidence.

When the evidence remains ambiguous, keep the content together, preserve its
geometry, and let the AI interpretation stage resolve it.
