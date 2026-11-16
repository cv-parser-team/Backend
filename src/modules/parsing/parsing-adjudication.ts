import type {
  LayoutAdjudications,
  LayoutLine,
  LayoutTrace,
  LayoutTracePage,
  PageAdjudications
} from './layout.js';

// Uncertain parser decisions that an AI may settle. The AI only chooses one
// of the listed options; coordinates, ownership, and reading order are still
// computed by the deterministic pipeline afterwards.
export const ADJUDICATION_OPTIONS = {
  heading_role: ['section_heading', 'entry_headline', 'content'],
  entry_boundary: ['starts_entry', 'continues_entry'],
  gutter_meaning: ['shared_section', 'independent_sections', 'metadata_rail']
} as const;

export type AdjudicationKind = keyof typeof ADJUDICATION_OPTIONS;
export type AdjudicationOption<K extends AdjudicationKind = AdjudicationKind> =
  (typeof ADJUDICATION_OPTIONS)[K][number];

// Section evidence at or above this is worth asking about; below it the line
// is clearly not a heading.
export const HEADING_CASE_MINIMUM_SCORE = 0.5;
// Entry anchors in this confidence range are weak enough to ask about.
export const ENTRY_CASE_CONFIDENCE_RANGE = { minimum: 0.3, maximum: 0.6 } as const;
// Lines of nearby text given on each side of the case, to keep requests small.
export const NEARBY_LINE_COUNT = 3;
const MAXIMUM_LINE_TEXT = 120;

export interface AdjudicationCase {
  caseId: string;
  kind: AdjudicationKind;
  pageNumber: number;
  // The lines the decision is about, as page-local references such as "p1-l12".
  lineIndexes: number[];
  lineRefs: string[];
  options: readonly AdjudicationOption[];
  // What the deterministic pipeline decided; kept when the AI fails or is unsure.
  deterministic: AdjudicationOption;
  // Nearby lines, in visual order, as "ref: text".
  context: string[];
}

export function lineRef(pageNumber: number, lineIndex: number): string {
  return `p${pageNumber}-l${lineIndex}`;
}

function shortText(line: LayoutLine): string {
  const text = line.text.replace(/\s+/g, ' ').trim();
  return text.length > MAXIMUM_LINE_TEXT ? `${text.slice(0, MAXIMUM_LINE_TEXT - 1)}…` : text;
}

// Lines in visual order: top to bottom, then left to right.
function visualOrder(page: LayoutTracePage): number[] {
  return page.reconstructedLines
    .map((line, index) => ({ line, index }))
    .sort((left, right) =>
      Math.abs(left.line.box.y - right.line.box.y) > left.line.box.height / 2
        ? left.line.box.y - right.line.box.y
        : left.line.box.x - right.line.box.x
    )
    .map(({ index }) => index);
}

function nearbyContext(
  page: LayoutTracePage,
  order: number[],
  lineIndexes: number[]
): string[] {
  const positions = lineIndexes.map((lineIndex) => order.indexOf(lineIndex));
  const first = Math.max(0, Math.min(...positions) - NEARBY_LINE_COUNT);
  const last = Math.min(order.length - 1, Math.max(...positions) + NEARBY_LINE_COUNT);
  return order.slice(first, last + 1).map((lineIndex) => {
    const line = page.reconstructedLines[lineIndex]!;
    const style = line.bold ? ' [bold]' : '';
    return `${lineRef(page.pageNumber, lineIndex)}${style}: ${shortText(line)}`;
  });
}

function headingCases(page: LayoutTracePage): Omit<AdjudicationCase, 'caseId' | 'context'>[] {
  const anchorLines = new Set(page.entryAnchors.map((anchor) => anchor.lineIndex));
  return page.sectionScopes
    .filter((scope) => scope.status === 'provisional' && scope.mode !== 'provisional-cell')
    .filter((scope) => {
      const candidate = page.boundaryCandidates.find(
        (item) => item.lineIndex === scope.headingLineIndex
      );
      return (
        candidate !== undefined &&
        (candidate.section.score >= HEADING_CASE_MINIMUM_SCORE ||
          scope.reasons.includes('entry evidence competes with section evidence'))
      );
    })
    .map((scope) => ({
      kind: 'heading_role' as const,
      pageNumber: page.pageNumber,
      lineIndexes: [scope.headingLineIndex],
      lineRefs: [lineRef(page.pageNumber, scope.headingLineIndex)],
      options: ADJUDICATION_OPTIONS.heading_role,
      deterministic: anchorLines.has(scope.headingLineIndex) ? 'entry_headline' : 'content'
    }));
}

function entryCases(page: LayoutTracePage): Omit<AdjudicationCase, 'caseId' | 'context'>[] {
  const { minimum, maximum } = ENTRY_CASE_CONFIDENCE_RANGE;
  return page.entryAnchors
    .filter(
      (anchor) =>
        anchor.demotedSectionCandidate ||
        (anchor.confidence >= minimum && anchor.confidence < maximum)
    )
    .map((anchor) => ({
      kind: 'entry_boundary' as const,
      pageNumber: page.pageNumber,
      lineIndexes: [anchor.lineIndex],
      lineRefs: [lineRef(page.pageNumber, anchor.lineIndex)],
      options: ADJUDICATION_OPTIONS.entry_boundary,
      deterministic: 'starts_entry'
    }));
}

// Same-row heading candidates the pipeline could not resolve form one case:
// the gutter between them is either inside one section, between independent
// sections, or beside a rail of metadata.
function gutterCases(page: LayoutTracePage): Omit<AdjudicationCase, 'caseId' | 'context'>[] {
  const cells = page.sectionScopes.filter((scope) => scope.mode === 'provisional-cell');
  const rows: number[][] = [];
  for (const scope of cells) {
    const line = page.reconstructedLines[scope.headingLineIndex]!;
    const row = rows.find((indexes) => {
      const peer = page.reconstructedLines[indexes[0]!]!;
      return Math.abs(peer.box.y - line.box.y) <= Math.max(peer.box.height, line.box.height) / 2;
    });
    if (row) {
      row.push(scope.headingLineIndex);
    } else {
      rows.push([scope.headingLineIndex]);
    }
  }

  return rows
    .filter((indexes) => indexes.length > 1)
    .map((indexes) => {
      const sorted = [...indexes].sort(
        (left, right) =>
          page.reconstructedLines[left]!.box.x - page.reconstructedLines[right]!.box.x
      );
      return {
        kind: 'gutter_meaning' as const,
        pageNumber: page.pageNumber,
        lineIndexes: sorted,
        lineRefs: sorted.map((lineIndex) => lineRef(page.pageNumber, lineIndex)),
        options: ADJUDICATION_OPTIONS.gutter_meaning,
        // Ambiguous gutters stay unsplit.
        deterministic: 'shared_section'
      };
    });
}

// The AI choices that differ from what the pipeline already does, as role
// overrides per page. Choices equal to the deterministic result change nothing.
export function toLayoutAdjudications(
  cases: AdjudicationCase[],
  choices: ReadonlyMap<string, AdjudicationOption>
): LayoutAdjudications {
  const pages = new Map<number, {
    confirmedHeadings: Set<number>;
    independentHeadings: Set<number>;
    notHeadings: Set<number>;
    continuingAnchors: Set<number>;
  }>();
  const pageOf = (pageNumber: number) => {
    let page = pages.get(pageNumber);
    if (!page) {
      page = {
        confirmedHeadings: new Set(),
        independentHeadings: new Set(),
        notHeadings: new Set(),
        continuingAnchors: new Set()
      };
      pages.set(pageNumber, page);
    }
    return page;
  };

  for (const item of cases) {
    const choice = choices.get(item.caseId);
    if (!choice || choice === item.deterministic) {
      continue;
    }
    const page = pageOf(item.pageNumber);
    const target =
      choice === 'section_heading'
        ? page.confirmedHeadings
        : choice === 'continues_entry'
          ? page.continuingAnchors
          : choice === 'independent_sections'
            ? page.independentHeadings
            : choice === 'metadata_rail'
              ? page.notHeadings
              : undefined;
    item.lineIndexes.forEach((lineIndex) => target?.add(lineIndex));
  }

  return new Map<number, PageAdjudications>(pages);
}

// Collects every uncertain decision of a CV, in page order, with the nearby
// text needed to decide it. Confident decisions are never included.
export function collectAdjudicationCases(trace: LayoutTrace): AdjudicationCase[] {
  return trace.pages.flatMap((page) => {
    const order = visualOrder(page);
    const cases = [...headingCases(page), ...entryCases(page), ...gutterCases(page)];
    const seen = new Set<string>();
    return cases
      .filter((item) => {
        // A line already asked about as a heading is not asked about again.
        const key = item.lineRefs.join(',');
        const duplicate = item.lineIndexes.some((lineIndex) =>
          seen.has(lineRef(page.pageNumber, lineIndex))
        );
        item.lineRefs.forEach((ref) => seen.add(ref));
        return key && !duplicate;
      })
      .map((item) => ({
        ...item,
        caseId: `${item.kind}:${item.lineRefs.join(',')}`,
        context: nearbyContext(page, order, item.lineIndexes)
      }));
  });
}
