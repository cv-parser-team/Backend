import {
  BoundingBox,
  DrawnSeparator,
  ParsedPage,
  Region,
  TextLine,
  TextPiece
} from './parsing.types.js';
import {
  generateBoundaryCandidates,
  type BoundaryCandidate,
  type NonTextBoundaryCandidate
} from './boundary-candidates.js';
import {
  generateLayoutZoneCandidates,
  type LayoutZoneCandidate
} from './macro-layout.js';
import {
  establishSectionScopes,
  type SectionAdjudications,
  type SectionScope
} from './section-scopes.js';
import {
  resolveEntries,
  type EntryGroup,
  type ResolvedEntryAnchor
} from './entry-groups.js';
import {
  resolveFinalLayout,
  type FinalRegionDraft,
  type SectionColumn,
  type ValidatedLayoutZone
} from './final-layout.js';

// Layout works on text pieces with page coordinates and knows nothing about
// the file format, so any source of positioned text can use it.

export interface PositionedPage {
  pageNumber: number;
  width: number;
  height: number;
  pieces: TextPiece[];
  // Small drawn shapes, such as list bullets drawn as dots.
  marks: BoundingBox[];
  // Thin drawn rules. Stage 1 preserves them for inspection but does not use
  // them to change layout decisions.
  separators: DrawnSeparator[];
}

// Stage 2 output: visual text reconstructed from PDF pieces, before any
// heading, section, entry, or column inference.
export type LayoutLine = Omit<TextLine, 'order' | 'heading'>;

export interface MetricCluster {
  value: number;
  count: number;
  share: number;
}

export interface StyleCluster {
  height: number;
  bold: boolean;
  italic: boolean;
  count: number;
  share: number;
}

export interface WhitespaceCandidate {
  box: BoundingBox;
  size: number;
  coverage: number;
}

export interface SeparatorCoverage {
  separatorIndex: number;
  coverage: number;
}

// Stage 3 output: page-local observations only. Candidates in this structure
// do not split lines, establish ownership, or classify document roles.
export interface PageMetrics {
  usualBodyHeight: number;
  usualVerticalGap: number;
  activeContentBox: BoundingBox | null;
  leftEdges: MetricCluster[];
  rightEdges: MetricCluster[];
  rowBaselines: MetricCluster[];
  heightClusters: MetricCluster[];
  styleClusters: StyleCluster[];
  verticalGutters: WhitespaceCandidate[];
  horizontalBands: WhitespaceCandidate[];
  separatorCoverage: SeparatorCoverage[];
}

export interface LayoutTracePage {
  pageNumber: number;
  width: number;
  height: number;
  pieces: TextPiece[];
  marks: BoundingBox[];
  separators: DrawnSeparator[];
  reconstructedLines: LayoutLine[];
  metrics: PageMetrics;
  boundaryCandidates: BoundaryCandidate[];
  nonTextBoundaryCandidates: NonTextBoundaryCandidate[];
  layoutZoneCandidates: LayoutZoneCandidate[];
  sectionScopes: SectionScope[];
  entryAnchors: ResolvedEntryAnchor[];
  entryGroups: EntryGroup[];
  validatedZones: ValidatedLayoutZone[];
  sectionColumns: SectionColumn[];
  finalRegions: FinalRegionDraft[];
  revisedAiInputLines: string[];
}

export interface LayoutTrace {
  usualHeight: number;
  usualGap: number;
  pages: LayoutTracePage[];
}

// Decisions an AI made about uncertain roles on one page. Stages apply them as
// role overrides and derive geometry, ownership, and order as usual.
export interface PageAdjudications extends SectionAdjudications {
  continuingAnchors?: ReadonlySet<number>;
}

// By page number.
export type LayoutAdjudications = ReadonlyMap<number, PageAdjudications>;

// A bullet character or a list number at the start of a line.
export const BULLET = /^([•●▪◦‣∙·*\-–—]|\d+[.)])\s/;

// Text with spaced-out letters, such as "C O N T A C T :", as text extraction
// returns it for designs that space out the letters of headings. A long
// heading can come in several pieces, such as "A B O U T" and "M E".
export const SPACED_LETTERS = /^\p{L}( \p{L})+( ?:)?$/u;

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function unionBox(boxes: BoundingBox[]): BoundingBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

function toLine(pieces: TextPiece[]): LayoutLine {
  let text = '';
  pieces.forEach((piece, index) => {
    const previous = pieces[index - 1];
    if (previous) {
      const gap = piece.box.x - (previous.box.x + previous.box.width);
      const needsSpace = gap > piece.box.height * 0.15 && !text.endsWith(' ') && !piece.text.startsWith(' ');
      text += needsSpace ? ' ' : '';
    }
    text += piece.text;
  });
  // A line is bold or italic when most of its characters are.
  const styledLength = (style: 'bold' | 'italic') =>
    pieces.filter((piece) => piece[style]).reduce((total, piece) => total + piece.text.length, 0);
  return {
    text: text.trim(),
    box: unionBox(pieces.map((piece) => piece.box)),
    bold: styledLength('bold') * 2 > text.length,
    italic: styledLength('italic') * 2 > text.length,
    bullet: BULLET.test(text.trim()),
    links: [...new Set(pieces.flatMap((piece) => piece.links))]
  };
}

// A mark no taller than the line, just before its start and level with it,
// is a list bullet drawn as a shape.
function markBullets(lines: LayoutLine[], marks: BoundingBox[]): LayoutLine[] {
  return lines.map((line) => {
    const { x, y, height } = line.box;
    const drawnBullet = marks.some((mark) => {
      const markRight = mark.x + mark.width;
      const markCenter = mark.y + mark.height / 2;
      return (
        mark.width <= height &&
        mark.height <= height &&
        markRight <= x + 1 &&
        x - markRight <= height * 2 &&
        markCenter >= y &&
        markCenter <= y + height
      );
    });
    return drawnBullet ? { ...line, bullet: true } : line;
  });
}

// Some designs draw the same text twice, slightly shifted, for a shadow or
// outline effect. Only the first copy is kept.
function withoutOverlaidCopies(pieces: TextPiece[]): TextPiece[] {
  const kept: TextPiece[] = [];
  for (const piece of pieces) {
    const text = piece.text.trim();
    const copy = kept.some(
      (other) =>
        other.text.trim() === text &&
        Math.abs(other.box.x - piece.box.x) <= piece.box.height / 2 &&
        Math.abs(other.box.y - piece.box.y) <= piece.box.height / 2
    );
    if (!copy) {
      kept.push(piece);
    }
  }
  return kept;
}

// Pieces at the same height form a row. A wide horizontal gap splits a row
// into separate lines.
function groupLines(pieces: TextPiece[]): LayoutLine[] {
  const sorted = withoutOverlaidCopies(pieces).sort(
    (a, b) => a.box.y - b.box.y || a.box.x - b.box.x
  );
  const rows: TextPiece[][] = [];

  for (const piece of sorted) {
    const row = rows[rows.length - 1];
    const anchor = row?.[0];
    const sameRow =
      anchor !== undefined &&
      Math.abs(anchor.box.y + anchor.box.height / 2 - (piece.box.y + piece.box.height / 2)) <=
        Math.min(anchor.box.height, piece.box.height) / 2;
    if (row && sameRow) {
      row.push(piece);
    } else {
      rows.push([piece]);
    }
  }

  return rows.flatMap((row) => {
    const ordered = row.sort((a, b) => a.box.x - b.box.x);
    const lines: TextPiece[][] = [[ordered[0]!]];
    for (const piece of ordered.slice(1)) {
      const current = lines[lines.length - 1]!;
      const previous = current[current.length - 1]!;
      const gap = piece.box.x - (previous.box.x + previous.box.width);
      if (gap > Math.max(previous.box.height, piece.box.height) * 2) {
        lines.push([piece]);
      } else {
        current.push(piece);
      }
    }
    return lines.map(toLine);
  });
}

// Reconstruct visual lines without assigning semantic or layout authority.
// Separators deliberately do not participate in this stage.
export function reconstructLines(
  pieces: TextPiece[],
  marks: BoundingBox[]
): LayoutLine[] {
  return markBullets(groupLines(pieces), marks);
}

// Starting values for region detection, kept in one place so they can be
// tuned on real CVs.
export const LAYOUT_SETTINGS = {
  // A gutter must be at least this many line heights wide.
  minGutterLineHeights: 1.5,
  // Lines starting within this many points share a left edge.
  alignmentTolerance: 3,
  // Used only when compact AI input decides whether adjacent heading lines wrap.
  headingHeightRatio: 1.15,
};

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function right(box: BoundingBox): number {
  return box.x + box.width;
}

function centerY(box: BoundingBox): number {
  return box.y + box.height / 2;
}

// The spaces between each line and the line above it in the same column, so
// lines of side-by-side columns do not shrink them.
function lineGaps(lines: LayoutLine[]): number[] {
  return lines.flatMap((line) => {
    const above = lines.filter(
      (other) =>
        other !== line &&
        other.box.y + other.box.height <= line.box.y &&
        other.box.x < right(line.box) &&
        line.box.x < right(other.box)
    );
    if (above.length === 0) {
      return [];
    }
    const nearestBottom = Math.max(...above.map((other) => other.box.y + other.box.height));
    return [line.box.y - nearestBottom];
  });
}

function clusterValues(values: number[], tolerance: number): MetricCluster[] {
  if (values.length === 0) {
    return [];
  }
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const value of sorted) {
    const group = groups[groups.length - 1];
    if (group && Math.abs(value - median(group)) <= tolerance) {
      group.push(value);
    } else {
      groups.push([value]);
    }
  }
  return groups
    .map((group) => ({
      value: round(median(group)),
      count: group.length,
      share: round(group.length / values.length)
    }))
    .sort((a, b) => b.count - a.count || a.value - b.value);
}

function usualClusterValue(values: number[], tolerance: number): number {
  if (values.length === 0) {
    return 0;
  }
  const clusters = clusterValues(values, tolerance);
  const repeated = clusters.filter((cluster) => cluster.count > 1);
  return repeated.length > 0 ? repeated[0]!.value : round(median(values));
}

function coveredLength(ranges: { start: number; end: number }[]): number {
  if (ranges.length === 0) {
    return 0;
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let start = sorted[0]!.start;
  let end = sorted[0]!.end;
  for (const range of sorted.slice(1)) {
    if (range.start <= end) {
      end = Math.max(end, range.end);
    } else {
      total += end - start;
      start = range.start;
      end = range.end;
    }
  }
  return total + end - start;
}

function styleClusters(lines: LayoutLine[], heightTolerance: number): StyleCluster[] {
  const groups: { lines: LayoutLine[]; bold: boolean; italic: boolean }[] = [];
  for (const line of [...lines].sort((a, b) => a.box.height - b.box.height)) {
    const group = groups.find(
      (candidate) =>
        candidate.bold === line.bold &&
        candidate.italic === line.italic &&
        Math.abs(median(candidate.lines.map((item) => item.box.height)) - line.box.height) <=
          heightTolerance
    );
    if (group) {
      group.lines.push(line);
    } else {
      groups.push({ lines: [line], bold: line.bold, italic: line.italic });
    }
  }
  return groups
    .map((group) => ({
      height: round(median(group.lines.map((line) => line.box.height))),
      bold: group.bold,
      italic: group.italic,
      count: group.lines.length,
      share: round(group.lines.length / lines.length)
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.height - b.height ||
        Number(a.bold) - Number(b.bold) ||
        Number(a.italic) - Number(b.italic)
    );
}

function verticalGutterCandidates(
  lines: LayoutLine[],
  activeBox: BoundingBox,
  usualBodyHeight: number
): WhitespaceCandidate[] {
  const minimumWidth = Math.max(3, usualBodyHeight * LAYOUT_SETTINGS.minGutterLineHeights);
  const repeatedRightEdges = clusterValues(
    lines.map((line) => right(line.box)),
    LAYOUT_SETTINGS.alignmentTolerance
  ).filter((cluster) => cluster.count >= 2);
  const repeatedLeftEdges = clusterValues(
    lines.map((line) => line.box.x),
    LAYOUT_SETTINGS.alignmentTolerance
  ).filter((cluster) => cluster.count >= 2);
  const candidates: WhitespaceCandidate[] = [];
  for (const leftEdge of repeatedRightEdges) {
    const rightEdge = repeatedLeftEdges
      .filter((cluster) => cluster.value - leftEdge.value >= minimumWidth)
      .sort((a, b) => a.value - b.value)[0];
    if (!rightEdge) {
      continue;
    }
    const crossingRanges = lines
      .filter(
        (line) => line.box.x < rightEdge.value && right(line.box) > leftEdge.value
      )
      .map((line) => ({ start: line.box.y, end: line.box.y + line.box.height }));
    const coverage = activeBox.height === 0
      ? 0
      : clamp(1 - coveredLength(crossingRanges) / activeBox.height);
    if (coverage < 0.6) {
      continue;
    }
    candidates.push({
      box: {
        x: leftEdge.value,
        y: activeBox.y,
        width: round(rightEdge.value - leftEdge.value),
        height: activeBox.height
      },
      size: round(rightEdge.value - leftEdge.value),
      coverage: round(coverage)
    });
  }
  return candidates
    .sort((a, b) => b.coverage - a.coverage || b.size - a.size || a.box.x - b.box.x)
    .filter(
      (candidate, index, sorted) =>
        sorted.findIndex(
          (other) =>
            Math.abs(other.box.x - candidate.box.x) <= LAYOUT_SETTINGS.alignmentTolerance &&
            Math.abs(right(other.box) - right(candidate.box)) <= LAYOUT_SETTINGS.alignmentTolerance
        ) === index
    );
}

function horizontalBandCandidates(
  lines: LayoutLine[],
  activeBox: BoundingBox,
  usualBodyHeight: number
): WhitespaceCandidate[] {
  const occupied = [...lines]
    .map((line) => ({ start: line.box.y, end: line.box.y + line.box.height }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (occupied.length < 2) {
    return [];
  }
  // Preserve plausible whitespace observations even on sparse pages, where
  // the only measured line gap may itself be a section-sized band. Later
  // boundary scoring decides how much authority the band receives.
  const minimumHeight = Math.max(2, usualBodyHeight * 0.5);
  const bands: WhitespaceCandidate[] = [];
  let bottom = occupied[0]!.end;
  for (const range of occupied.slice(1)) {
    const gap = range.start - bottom;
    if (gap >= minimumHeight) {
      bands.push({
        box: {
          x: activeBox.x,
          y: round(bottom),
          width: activeBox.width,
          height: round(gap)
        },
        size: round(gap),
        coverage: 1
      });
    }
    bottom = Math.max(bottom, range.end);
  }
  return bands.sort((a, b) => a.box.y - b.box.y);
}

export function measurePageMetrics(
  lines: LayoutLine[],
  separators: DrawnSeparator[]
): PageMetrics {
  if (lines.length === 0) {
    return {
      usualBodyHeight: 0,
      usualVerticalGap: 0,
      activeContentBox: null,
      leftEdges: [],
      rightEdges: [],
      rowBaselines: [],
      heightClusters: [],
      styleClusters: [],
      verticalGutters: [],
      horizontalBands: [],
      separatorCoverage: separators.map((_, separatorIndex) => ({ separatorIndex, coverage: 0 }))
    };
  }

  const activeContentBox = unionBox(lines.map((line) => line.box));
  const heights = lines.map((line) => line.box.height);
  const heightTolerance = Math.max(0.5, median(heights) * 0.08);
  const usualBodyHeight = usualClusterValue(heights, heightTolerance);
  const positiveGaps = lineGaps(lines).filter((gap) => gap > 0);
  const gapTolerance = Math.max(1, usualBodyHeight * 0.2);
  const usualVerticalGap = usualClusterValue(positiveGaps, gapTolerance) || round(usualBodyHeight * 0.3);
  const edgeTolerance = LAYOUT_SETTINGS.alignmentTolerance;

  return {
    usualBodyHeight,
    usualVerticalGap,
    activeContentBox,
    leftEdges: clusterValues(lines.map((line) => line.box.x), edgeTolerance),
    rightEdges: clusterValues(lines.map((line) => right(line.box)), edgeTolerance),
    rowBaselines: clusterValues(lines.map((line) => centerY(line.box)), edgeTolerance),
    heightClusters: clusterValues(heights, heightTolerance),
    styleClusters: styleClusters(lines, heightTolerance),
    verticalGutters: verticalGutterCandidates(lines, activeContentBox, usualBodyHeight),
    horizontalBands: horizontalBandCandidates(
      lines,
      activeContentBox,
      usualBodyHeight
    ),
    separatorCoverage: separators.map((separator, separatorIndex) => ({
      separatorIndex,
      coverage: round(
        separator.orientation === 'horizontal'
          ? clamp(separator.box.width / activeContentBox.width)
          : clamp(separator.box.height / activeContentBox.height)
      )
    }))
  };
}

// Builds pages from the resolved section scopes, entry groups, and constrained
// final ownership. Reading order is unique across the document.
export function buildPages(pages: PositionedPage[]): ParsedPage[] {
  return buildPagesInternal(pages, false).pages;
}

export function buildPagesWithTrace(
  pages: PositionedPage[],
  adjudications?: LayoutAdjudications
): { pages: ParsedPage[]; trace: LayoutTrace } {
  const built = buildPagesInternal(pages, true, adjudications);
  if (!built.trace) {
    throw new Error('Layout trace was not collected');
  }
  return { pages: built.pages, trace: built.trace };
}

function buildPagesInternal(
  pages: PositionedPage[],
  collectTrace: boolean,
  adjudications?: LayoutAdjudications
): { pages: ParsedPage[]; trace: LayoutTrace | null } {
  const pageLines = pages.map(({ pieces, marks }) => reconstructLines(pieces, marks));
  const pageMetrics = pages.map((page, pageIndex) =>
    measurePageMetrics(pageLines[pageIndex]!, page.separators)
  );
  const allLines = pageLines.flat();
  const usualHeight = median(allLines.map((line) => line.box.height));
  const usualGap = median(pageLines.flatMap(lineGaps)) || usualHeight * 0.3;
  let order = 0;

  const tracePages: LayoutTracePage[] = [];

  const parsedPages = pages.map(({ pieces, marks, separators, ...page }, pageIndex) => {
    const candidates = generateBoundaryCandidates({
      lines: pageLines[pageIndex]!,
      metrics: pageMetrics[pageIndex]!,
      separators,
      pageIndex,
      pageHeight: page.height
    });
    const layoutZoneCandidates = generateLayoutZoneCandidates({
      lines: pageLines[pageIndex]!,
      metrics: pageMetrics[pageIndex]!,
      boundaryCandidates: candidates.lines,
      nonTextBoundaryCandidates: candidates.nonText
    });
    const pageAdjudications = adjudications?.get(page.pageNumber);
    const sectionScopes = establishSectionScopes({
      lines: pageLines[pageIndex]!,
      metrics: pageMetrics[pageIndex]!,
      boundaryCandidates: candidates.lines,
      nonTextBoundaryCandidates: candidates.nonText,
      layoutZoneCandidates,
      adjudications: pageAdjudications
    });
    const entryResolution = resolveEntries({
      lines: pageLines[pageIndex]!,
      metrics: pageMetrics[pageIndex]!,
      boundaryCandidates: candidates.lines,
      sectionScopes,
      continuingAnchors: pageAdjudications?.continuingAnchors
    });
    const finalLayout = resolveFinalLayout({
      pageNumber: page.pageNumber,
      lines: pageLines[pageIndex]!,
      layoutZoneCandidates,
      sectionScopes,
      entryGroups: entryResolution.groups
    });
    if (collectTrace) {
      tracePages.push({
        ...page,
        pieces,
        marks,
        separators,
        reconstructedLines: pageLines[pageIndex]!,
        metrics: pageMetrics[pageIndex]!,
        boundaryCandidates: candidates.lines,
        nonTextBoundaryCandidates: candidates.nonText,
        layoutZoneCandidates,
        sectionScopes,
        entryAnchors: entryResolution.anchors,
        entryGroups: entryResolution.groups,
        validatedZones: finalLayout.validatedZones,
        sectionColumns: finalLayout.sectionColumns,
        finalRegions: finalLayout.regions,
        revisedAiInputLines: finalLayout.aiInputLines
      });
    }
    const headingLineIndexes = new Set(
      sectionScopes
        .filter((scope) => scope.status === 'confirmed')
        .map((scope) => scope.headingLineIndex)
    );
    candidates.lines.forEach((candidate) => {
      if (candidate.header.score >= 0.8 && candidate.header.score > candidate.section.score) {
        headingLineIndexes.add(candidate.lineIndex);
      }
      if (
        candidate.section.reasons.includes('continues a split common section heading') &&
        sectionScopes.some(
          (scope) => scope.status === 'confirmed' && scope.lineIndexes.includes(candidate.lineIndex)
        )
      ) {
        headingLineIndexes.add(candidate.lineIndex);
      }
    });
    const regions: Region[] = finalLayout.regions.map((region) => ({
      index: region.index,
      role: region.role,
      parentIndex: region.parentIndex,
      box: region.box,
      confidence: region.confidence,
      lines: region.readingOrderLineIndexes.map((lineIndex) => {
        const line = pageLines[pageIndex]![lineIndex]!;
        const heading = headingLineIndexes.has(lineIndex);
        return {
          order: ++order,
          ...line,
          heading,
          bullet: line.bullet && !heading
        };
      })
    }));
    return { ...page, regions };
  });

  return {
    pages: parsedPages,
    trace: collectTrace
      ? { usualHeight: round(usualHeight), usualGap: round(usualGap), pages: tracePages }
      : null
  };
}
