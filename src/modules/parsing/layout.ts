import {
  BoundingBox,
  DrawnSeparator,
  ParsedPage,
  Region,
  TextLine,
  TextPiece
} from './parsing.types.js';
import {
  HEADING_SETTINGS,
  scoreHeading,
  type HeadingScore
} from './heading-classifier.js';
import {
  headingLayoutAction,
  type HeadingClassification,
  type HeadingLayoutAction
} from './heading-layout-policy.js';
import {
  generateBoundaryCandidates,
  type BoundaryCandidate,
  type NonTextBoundaryCandidate
} from './boundary-candidates.js';
import {
  generateLayoutZoneCandidates,
  type LayoutZoneCandidate
} from './macro-layout.js';

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

export type LayoutTraceLine = LayoutLine & {
  heading: boolean;
  layoutAction: HeadingLayoutAction;
};

type LineDraft = LayoutTraceLine;

export interface LayoutTraceRegion {
  box: BoundingBox;
  confidence: number | null;
  lines: LayoutTraceLine[];
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
  classifiedLines: LayoutTraceLine[];
  splitRegions: LayoutTraceRegion[];
  ownedRegions: LayoutTraceRegion[];
}

export interface LayoutTrace {
  usualHeight: number;
  usualGap: number;
  pages: LayoutTracePage[];
}

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

const LINE_LANE_TOLERANCE = 3;
const REPEATED_LANE_ROW_COUNT = 2;

function hasRepeatedLanePair(
  rows: TextPiece[][],
  sourceRow: TextPiece[],
  left: number,
  right: number
): boolean {
  let matchingRows = 0;
  const sourceCenter = median(sourceRow.map((piece) => centerY(piece.box)));
  const sourceHeight = median(sourceRow.map((piece) => piece.box.height));
  for (const row of rows) {
    const rowCenter = median(row.map((piece) => centerY(piece.box)));
    const rowHeight = median(row.map((piece) => piece.box.height));
    if (Math.abs(rowCenter - sourceCenter) > Math.max(sourceHeight, rowHeight) * 3) {
      continue;
    }
    const hasLeft = row.some((piece) => Math.abs(piece.box.x - left) <= LINE_LANE_TOLERANCE);
    const hasRight = row.some((piece) => Math.abs(piece.box.x - right) <= LINE_LANE_TOLERANCE);
    if (hasLeft && hasRight) {
      matchingRows += 1;
      if (matchingRows >= REPEATED_LANE_ROW_COUNT) {
        return true;
      }
    }
  }
  return false;
}

// Pieces at the same height form a row. A wide horizontal gap splits a row
// into separate lines. Repeated starts on multiple rows also identify narrow
// table or grid columns whose gutter alone is too small to be conclusive.
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
      const repeatedLanes =
        gap > 0 && hasRepeatedLanePair(rows, row, current[0]!.box.x, piece.box.x);
      if (gap > Math.max(previous.box.height, piece.box.height) * 2 || repeatedLanes) {
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
  weights: {
    gutterContinuity: 0.4,
    alignment: 0.3,
    regionWidth: 0.15,
    headingSupport: 0.1,
    lineSpacing: 0.05
  },
  splitScore: 0.7,
  supportedSplitScore: 0.5,
  strongSignal: 0.7,
  // Shares of the region width between which the narrower side's width
  // signal rises from 0 to 1.
  narrowWidthShare: 0.1,
  wideWidthShare: 0.25,
  // A gutter must be at least this many line heights wide.
  minGutterLineHeights: 1.5,
  // Lines starting within this many points share a left edge.
  alignmentTolerance: 3,
  // When this share of one side's lines sits on the same rows as the other
  // side, the gap separates cells of shared rows (a table or right-aligned
  // dates), not columns.
  sharedRowShare: 0.8,
  // A vertical gap this many times the usual gap may start a new section.
  sectionGapRatio: 2,
  // Lines this many times taller than the usual line are headings.
  headingHeightRatio: 1.15,
  readingDirection: 'ltr' as 'ltr' | 'rtl'
};

const ENTRY_DATE = /(?:\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bpresent\b)/iu;
const ENTRY_CONTACT = /(?:@|https?:\/\/|www\.|\+?\d[\d ().-]{6,}\d)/iu;
const ENTRY_WORD_LIMIT = 8;

interface RegionDraft {
  lines: LineDraft[];
  confidence: number | null;
}

interface Split {
  parts: [LineDraft[], LineDraft[]];
  confidence: number;
}

interface ColumnSplit extends Split {
  // The empty band between the columns, from the right edge of the left
  // column to the left edge of the right column.
  gutter: { left: number; right: number };
}

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

function byReadingPosition(a: LayoutLine, b: LayoutLine): number {
  return a.box.y - b.box.y || a.box.x - b.box.x;
}

function right(box: BoundingBox): number {
  return box.x + box.width;
}

function centerY(box: BoundingBox): number {
  return box.y + box.height / 2;
}

function sharesRow(first: LayoutLine, second: LayoutLine): boolean {
  return (
    Math.abs(centerY(first.box) - centerY(second.box)) <=
    Math.min(first.box.height, second.box.height) / 2
  );
}

function ownershipBoundaryRank(line: LineDraft): number {
  switch (line.layoutAction) {
    case 'section-boundary':
      return 0;
    case 'entry-boundary':
      return 1;
    case 'header-boundary':
    case 'none':
      return 2;
  }
}

// A side label owns content on the same visual row even when the label is to
// its right. Keep the semantic boundary before that content inside a region;
// ordinary rows retain their geometric left-to-right order.
function byOwnedReadingPosition(a: LineDraft, b: LineDraft): number {
  if (
    sharesRow(a, b) ||
    Math.abs(a.box.y - b.box.y) <= LAYOUT_SETTINGS.alignmentTolerance
  ) {
    const boundaryOrder = ownershipBoundaryRank(a) - ownershipBoundaryRank(b);
    if (boundaryOrder !== 0) {
      return boundaryOrder;
    }
  }
  return byReadingPosition(a, b);
}

// Gaps between consecutive lines from top to bottom; overlapping lines count
// as no gap.
function verticalGaps(lines: LayoutLine[]): { gap: number; below: number }[] {
  const sorted = [...lines].sort(byReadingPosition);
  const gaps: { gap: number; below: number }[] = [];
  let bottom = sorted[0] ? sorted[0].box.y + sorted[0].box.height : 0;
  for (let index = 1; index < sorted.length; index++) {
    const line = sorted[index]!;
    gaps.push({ gap: Math.max(0, line.box.y - bottom), below: index });
    bottom = Math.max(bottom, line.box.y + line.box.height);
  }
  return gaps;
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

function shareWithCommonLeftEdge(lines: LineDraft[]): number {
  const best = Math.max(
    ...lines.map(
      (candidate) =>
        lines.filter(
          (line) => Math.abs(line.box.x - candidate.box.x) <= LAYOUT_SETTINGS.alignmentTolerance
        ).length
    )
  );
  return best / lines.length;
}

function shareOnSharedRows(lines: LineDraft[], others: LineDraft[]): number {
  const shared = lines.filter((line) =>
    others.some(
      (other) =>
        Math.abs(centerY(line.box) - centerY(other.box)) <=
        Math.min(line.box.height, other.box.height) / 2
    )
  ).length;
  return shared / lines.length;
}

function normalizedSpacing(lines: LineDraft[]): number {
  const height = median(lines.map((line) => line.box.height));
  return height === 0 ? 0 : median(verticalGaps(lines).map(({ gap }) => gap)) / height;
}

function isOwnershipBoundary(line: LineDraft): boolean {
  return line.layoutAction === 'section-boundary' || line.layoutAction === 'entry-boundary';
}

function isOwnershipMetadata(line: LineDraft): boolean {
  return ENTRY_DATE.test(line.text) || ENTRY_CONTACT.test(line.text);
}

function isCompactDateMetadata(line: LineDraft): boolean {
  return ENTRY_DATE.test(line.text) && wordCount(line.text) <= 5;
}

function isNearAnchor(anchor: LineDraft, candidate: LineDraft): boolean {
  const forwardGap = candidate.box.y - (anchor.box.y + anchor.box.height);
  return (
    sharesRow(anchor, candidate) ||
    (candidate.box.y >= anchor.box.y - LAYOUT_SETTINGS.alignmentTolerance &&
      forwardGap <= Math.max(anchor.box.height, candidate.box.height) * 1.5)
  );
}

// A title or compact metadata value may sit on either side of the content it
// describes. Such linked lines are one semantic block, even when an otherwise
// valid vertical gutter separates them. Links require visual-row alignment;
// merely nearby lines can still belong to genuinely parallel sections.
function hasCrossLaneOwnershipLink(left: LineDraft[], rightLines: LineDraft[]): boolean {
  const linksFrom = (sameLane: LineDraft[], otherLane: LineDraft[]) => {
    const linkedTitle = sameLane.some((anchor) => {
      if (!isOwnershipBoundary(anchor)) {
        return false;
      }
      const hasLocalBody = sameLane.some(
        (candidate) =>
          candidate !== anchor &&
          !isOwnershipBoundary(candidate) &&
          !isCompactDateMetadata(candidate) &&
          isNearAnchor(anchor, candidate)
      );
      if (hasLocalBody) {
        return false;
      }
      return otherLane.some(
        (candidate) => !isOwnershipBoundary(candidate) && sharesRow(anchor, candidate)
      );
    });
    if (linkedTitle) {
      return true;
    }

    const metadataOnlyLane =
      sameLane.length > 0 && sameLane.every((line) => isOwnershipMetadata(line));
    return (
      metadataOnlyLane &&
      shareOnSharedRows(sameLane, otherLane) >= LAYOUT_SETTINGS.sharedRowShare
    );
  };
  return linksFrom(left, rightLines) || linksFrom(rightLines, left);
}

function hasEquivalentSectionHeadings(left: LineDraft, rightLine: LineDraft): boolean {
  return (
    left.layoutAction === 'section-boundary' &&
    rightLine.layoutAction === 'section-boundary' &&
    sharesRow(left, rightLine)
  );
}

// Scores a gap between left and right groups of lines from several signals.
// The gap runs through the whole region, because no line crosses it.
function scoreColumnSplit(left: LineDraft[], rightLines: LineDraft[], regionWidth: number): number {
  const settings = LAYOUT_SETTINGS;
  const top = (lines: LineDraft[]) => [...lines].sort(byReadingPosition)[0]!;
  const parallelSections = hasEquivalentSectionHeadings(top(left), top(rightLines));
  // Peer section headings establish equal ownership lanes. The surrounding
  // caller has already proved that a sufficiently wide empty gutter exists,
  // so semantic peers make that gutter a decisive column boundary.
  if (parallelSections) {
    return 1;
  }
  if (hasCrossLaneOwnershipLink(left, rightLines)) {
    return 0;
  }
  if (
    Math.max(shareOnSharedRows(left, rightLines), shareOnSharedRows(rightLines, left)) >=
    settings.sharedRowShare
  ) {
    return 0;
  }

  const width = (lines: LineDraft[]) =>
    Math.max(...lines.map((line) => right(line.box))) - Math.min(...lines.map((line) => line.box.x));
  const narrowerShare = Math.min(width(left), width(rightLines)) / regionWidth;
  const signals = {
    gutterContinuity: 1,
    alignment: (shareWithCommonLeftEdge(left) + shareWithCommonLeftEdge(rightLines)) / 2,
    regionWidth: clamp(
      (narrowerShare - settings.narrowWidthShare) /
        (settings.wideWidthShare - settings.narrowWidthShare)
    ),
    headingSupport: top(left).heading && top(rightLines).heading ? 1 : 0,
    lineSpacing: clamp(Math.abs(normalizedSpacing(left) - normalizedSpacing(rightLines)))
  };

  const score = (Object.keys(signals) as (keyof typeof signals)[]).reduce(
    (total, name) => total + signals[name] * settings.weights[name],
    0
  );
  const strongSignals = Object.values(signals).filter(
    (value) => value >= settings.strongSignal
  ).length;
  return score >= settings.splitScore || (score >= settings.supportedSplitScore && strongSignals >= 2)
    ? score
    : 0;
}

// Finds the best vertical gutter: an empty band that no line crosses.
function findColumnSplit(lines: LineDraft[]): ColumnSplit | null {
  if (lines.length < 2) {
    return null;
  }
  const lineHeight = median(lines.map((line) => line.box.height));
  const regionLeft = Math.min(...lines.map((line) => line.box.x));
  const regionWidth = Math.max(...lines.map((line) => right(line.box))) - regionLeft;
  const byLeft = [...lines].sort((a, b) => a.box.x - b.box.x);

  let best: ColumnSplit | null = null;
  let coveredRight = right(byLeft[0]!.box);
  for (const line of byLeft.slice(1)) {
    const gutter = line.box.x - coveredRight;
    if (gutter >= lineHeight * LAYOUT_SETTINGS.minGutterLineHeights) {
      const left = lines.filter((candidate) => right(candidate.box) <= coveredRight);
      const rightLines = lines.filter((candidate) => candidate.box.x >= line.box.x);
      const confidence = scoreColumnSplit(left, rightLines, regionWidth);
      if (confidence > 0 && (!best || confidence > best.confidence)) {
        best = {
          parts: [left, rightLines],
          confidence,
          gutter: { left: coveredRight, right: line.box.x }
        };
      }
    }
    coveredRight = Math.max(coveredRight, right(line.box));
  }
  return best;
}

// Finds the widest empty horizontal band across the whole region that the
// given rule accepts. Because no line occupies the band, it spans the full
// width of the region.
function findBandSplit(
  lines: LineDraft[],
  usualGap: number,
  accept: (parts: [LineDraft[], LineDraft[]], firstBelow: LineDraft) => boolean
): Split | null {
  const sorted = [...lines].sort(byReadingPosition);
  const gaps = verticalGaps(sorted);
  const candidates = gaps
    .filter(({ gap }) => gap >= usualGap * LAYOUT_SETTINGS.sectionGapRatio)
    .sort((a, b) => b.gap - a.gap);

  for (const { gap, below } of candidates) {
    const parts: [LineDraft[], LineDraft[]] = [sorted.slice(0, below), sorted.slice(below)];
    if (accept(parts, sorted[below]!)) {
      return { parts, confidence: clamp(gap / (usualGap * LAYOUT_SETTINGS.sectionGapRatio * 2)) };
    }
  }
  return null;
}

// Lines that sit on both sides of a column gap without crossing it continue
// those columns, such as a row of section headings above them or sections
// whose lines happen to share rows.
function continuesColumns(lines: LineDraft[], gutter: ColumnSplit['gutter']): boolean {
  // A line may extend beyond the gutter midpoint while still belonging to one
  // lane. It only destroys the column boundary when it spans the entire empty
  // band that established the columns.
  const crossesGap = lines.some(
    (line) => line.box.x < gutter.left && right(line.box) > gutter.right
  );
  return (
    !crossesGap &&
    lines.some((line) => line.box.x < gutter.left && right(line.box) <= gutter.right) &&
    lines.some((line) => line.box.x >= gutter.left && right(line.box) > gutter.right)
  );
}

// A single section heading on the first row closes the lanes above it. Two or
// more aligned section headings instead open parallel lanes and should remain
// in column-major reading order.
function startsStandaloneSection(lines: LineDraft[], first: LineDraft): boolean {
  if (first.layoutAction !== 'section-boundary') {
    return false;
  }
  const alignedSections = lines.filter(
    (line) =>
      line.layoutAction === 'section-boundary' &&
      Math.abs(centerY(line.box) - centerY(first.box)) <=
        Math.min(line.box.height, first.box.height) / 2
  );
  return alignedSections.length === 1;
}

// A band that separates a full-width area, such as a header, from columns:
// one side has columns and the other does not. The other side is full width
// only when it crosses the column gap or sits on one side of it, such as a
// name above the main column. When both sides have columns, the columns are
// read whole instead.
function findFullWidthSplit(lines: LineDraft[], usualGap: number): Split | null {
  return findBandSplit(lines, usualGap, (parts, firstBelow) => {
    const [above, below] = parts.map(findColumnSplit);
    if (above && below) {
      return startsStandaloneSection(parts[1], firstBelow);
    }
    if (!above && !below) {
      return false;
    }
    const columns = (above ?? below)!;
    const other = above ? parts[1] : parts[0];
    return !continuesColumns(other, columns.gutter);
  });
}

// A band followed by a heading starts a new section. Bold body-size lines do
// not, because they can be job titles or company names inside a section.
function findSectionSplit(lines: LineDraft[], usualGap: number): Split | null {
  return findBandSplit(
    lines,
    usualGap,
    ([, below], firstBelow) =>
      below.some(
        (line) => line.layoutAction === 'section-boundary' && sharesRow(line, firstBelow)
      )
  );
}

// Repeated lower-level headings divide a section into entries. The first
// entry stays with its section heading; later entry anchors start new regions.
function findEntrySplit(lines: LineDraft[], usualGap: number): Split | null {
  return findBandSplit(
    lines,
    usualGap,
    ([above, below], firstBelow) =>
      below.some(
        (line) => line.layoutAction === 'entry-boundary' && sharesRow(line, firstBelow)
      ) &&
      above.some((line) => line.layoutAction === 'entry-boundary')
  );
}

// Splits a region recursively: full-width areas first, then columns, then
// sections. A region with no confident boundary is kept intact.
function splitRegion(
  lines: LineDraft[],
  confidence: number | null,
  usualGap: number
): RegionDraft[] {
  const fullWidth = findFullWidthSplit(lines, usualGap);
  if (fullWidth) {
    return fullWidth.parts.flatMap((part) => splitRegion(part, fullWidth.confidence, usualGap));
  }

  const columns = findColumnSplit(lines);
  if (columns) {
    const [left, rightLines] = columns.parts;
    const ordered = LAYOUT_SETTINGS.readingDirection === 'ltr' ? [left, rightLines] : [rightLines, left];
    return ordered.flatMap((part) => splitRegion(part, columns.confidence, usualGap));
  }

  const sections = findSectionSplit(lines, usualGap);
  if (sections) {
    return sections.parts.flatMap((part) => splitRegion(part, sections.confidence, usualGap));
  }

  const entries = findEntrySplit(lines, usualGap);
  if (entries) {
    return entries.parts.flatMap((part) => splitRegion(part, entries.confidence, usualGap));
  }

  return [{ lines: [...lines].sort(byOwnedReadingPosition), confidence }];
}

function startsWithSectionBoundary(region: RegionDraft): boolean {
  return region.lines[0]?.layoutAction === 'section-boundary';
}

function startsWithEntryBoundary(region: RegionDraft): boolean {
  return region.lines[0]?.layoutAction === 'entry-boundary';
}

function isStandaloneSectionBoundary(region: RegionDraft): boolean {
  return (
    region.lines.length > 0 &&
    region.lines.every((line) => line.layoutAction === 'section-boundary')
  );
}

function leftEdge(region: RegionDraft): number {
  return Math.min(...region.lines.map((line) => line.box.x));
}

function topEdge(region: RegionDraft): number {
  return Math.min(...region.lines.map((line) => line.box.y));
}

// A full-width section heading can be separated from columns below it during
// recursive splitting. Reattach those flat child regions after layout so the
// stored section box encloses its contents. Ownership remains conservative:
// another section boundary, a region starting in an earlier lane, or a region
// geometrically above the heading ends it. The vertical tolerance permits
// content that shares the heading's visual row despite small PDF coordinate
// differences.
function applySectionOwnership(regions: RegionDraft[], usualHeight: number): RegionDraft[] {
  const owned: RegionDraft[] = [];
  for (let index = 0; index < regions.length; ) {
    const owner = regions[index]!;
    if (!isStandaloneSectionBoundary(owner)) {
      owned.push(owner);
      index++;
      continue;
    }

    const ownerLeft = leftEdge(owner);
    const ownerTop = topEdge(owner);
    const children: RegionDraft[] = [];
    let ownsEntry = false;
    let childIndex = index + 1;
    while (childIndex < regions.length) {
      const candidate = regions[childIndex]!;
      if (
        startsWithSectionBoundary(candidate) ||
        (startsWithEntryBoundary(candidate) && ownsEntry) ||
        topEdge(candidate) < ownerTop - LAYOUT_SETTINGS.alignmentTolerance ||
        leftEdge(candidate) < ownerLeft - Math.max(usualHeight, LAYOUT_SETTINGS.alignmentTolerance)
      ) {
        break;
      }
      ownsEntry ||= startsWithEntryBoundary(candidate);
      children.push(candidate);
      childIndex++;
    }

    if (children.length === 0) {
      owned.push(owner);
      index++;
      continue;
    }

    const confidenceValues = [owner, ...children]
      .map((region) => region.confidence)
      .filter((confidence): confidence is number => confidence !== null);
    owned.push({
      lines: [owner, ...children].flatMap((region) => region.lines),
      confidence: confidenceValues.length > 0 ? Math.min(...confidenceValues) : null
    });
    index = childIndex;
  }
  return owned;
}

function horizontallyRelated(first: LayoutLine, second: LayoutLine): boolean {
  return (
    first.box.x <= right(second.box) &&
    second.box.x <= right(first.box)
  );
}

function hasWhitespaceAbove(
  line: LayoutLine,
  lines: LayoutLine[],
  usualGap: number
): boolean {
  const previousBottom = Math.max(
    ...lines
      .filter(
        (candidate) =>
          candidate !== line &&
          candidate.box.y + candidate.box.height <= line.box.y &&
          horizontallyRelated(candidate, line)
      )
      .map((candidate) => candidate.box.y + candidate.box.height),
    Number.NEGATIVE_INFINITY
  );
  return (
    Number.isFinite(previousBottom) &&
    line.box.y - previousBottom >= usualGap * LAYOUT_SETTINGS.sectionGapRatio
  );
}

function sameHeadingStyle(first: LayoutLine, second: LayoutLine): boolean {
  return (
    first.bold === second.bold &&
    Math.abs(first.box.height - second.box.height) <=
      Math.min(first.box.height, second.box.height) * 0.05
  );
}

interface HeadingStylePattern {
  sample: LayoutLine;
  laneXs: number[];
  sourceIndexes: number[];
}

function collectHeadingStylePatterns(
  lines: LayoutLine[],
  baseScores: HeadingScore[]
): HeadingStylePattern[] {
  const patterns: HeadingStylePattern[] = [];

  lines.forEach((line, index) => {
    const score = baseScores[index]!;
    if (
      score.confidence < HEADING_SETTINGS.candidateThreshold ||
      !hasIndependentSupport(score)
    ) {
      return;
    }

    const pattern = patterns.find((candidate) => sameHeadingStyle(candidate.sample, line));
    if (pattern) {
      pattern.laneXs.push(line.box.x);
      pattern.sourceIndexes.push(index);
      return;
    }

    patterns.push({ sample: line, laneXs: [line.box.x], sourceIndexes: [index] });
  });

  return patterns;
}

function countRepeatedHeadingStyles(
  line: LayoutLine,
  lineIndex: number,
  lines: LayoutLine[],
  patterns: HeadingStylePattern[]
): number {
  const pattern = patterns.find((candidate) => sameHeadingStyle(candidate.sample, line));
  if (
    !pattern ||
    !pattern.laneXs.some(
      (laneX) => Math.abs(laneX - line.box.x) <= LAYOUT_SETTINGS.alignmentTolerance
    )
  ) {
    return 0;
  }

  return pattern.sourceIndexes.filter(
    (sourceIndex) =>
      sourceIndex !== lineIndex &&
      Math.abs(lines[sourceIndex]!.box.x - line.box.x) <=
        LAYOUT_SETTINGS.alignmentTolerance
  ).length;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function isEntryAnchorCandidate(line: LineDraft): boolean {
  return (
    line.layoutAction === 'none' &&
    line.bold &&
    !line.bullet &&
    wordCount(line.text) > 0 &&
    wordCount(line.text) <= ENTRY_WORD_LIMIT &&
    !ENTRY_CONTACT.test(line.text) &&
    !/^\s*(?:(?:19|20)\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b)/iu.test(line.text)
  );
}

// Entry anchors are deliberately stricter than section headings. A short bold
// line must repeat in the same lane, have nearby body text, and be either
// larger than that body or accompanied by a date. This keeps isolated labels
// and contact rows from becoming regions.
function markEntryBoundaries(lines: LineDraft[], usualHeight: number): LineDraft[] {
  const candidates = lines.filter(isEntryAnchorCandidate);

  const nearbyBodies = (anchor: LineDraft, sameLane: boolean) =>
    [...lines]
      .filter(
        (candidate) =>
          candidate !== anchor &&
          candidate.box.y >= anchor.box.y - LAYOUT_SETTINGS.alignmentTolerance &&
          candidate.box.y - (anchor.box.y + anchor.box.height) <= usualHeight * 2 &&
          candidate.layoutAction === 'none' &&
          !candidate.bold &&
          horizontallyRelated(anchor, candidate) === sameLane
      )
      .sort(
        (first, second) =>
          Math.abs(first.box.y - anchor.box.y) - Math.abs(second.box.y - anchor.box.y) ||
          byReadingPosition(first, second)
      );

  return lines.map((line) => {
    if (!isEntryAnchorCandidate(line)) {
      return line;
    }

    const repeated = candidates.some(
      (candidate) =>
        candidate !== line &&
        Math.abs(candidate.box.x - line.box.x) <= LAYOUT_SETTINGS.alignmentTolerance &&
        Math.abs(candidate.box.height - line.box.height) <=
          Math.min(candidate.box.height, line.box.height) * 0.1
    );
    if (!repeated) {
      return line;
    }

    const sameLaneBody = nearbyBodies(line, true)[0];
    const crossLaneBody = nearbyBodies(line, false)[0];
    const repeatedCrossLaneBody = crossLaneBody
      ? candidates.some((candidate) => {
          if (
            candidate === line ||
            Math.abs(candidate.box.x - line.box.x) > LAYOUT_SETTINGS.alignmentTolerance ||
            Math.abs(candidate.box.height - line.box.height) >
              Math.min(candidate.box.height, line.box.height) * 0.1
          ) {
            return false;
          }
          const candidateBody = nearbyBodies(candidate, false)[0];
          return (
            candidateBody !== undefined &&
            Math.sign(candidateBody.box.x - candidate.box.x) ===
              Math.sign(crossLaneBody.box.x - line.box.x) &&
            Math.abs(candidateBody.box.x - crossLaneBody.box.x) <=
              LAYOUT_SETTINGS.alignmentTolerance
          );
        })
      : false;
    const nearbyBody = sameLaneBody ?? (repeatedCrossLaneBody ? crossLaneBody : undefined);
    if (!nearbyBody) {
      return line;
    }

    const alignedDate = lines.some(
      (candidate) => candidate !== line && sharesRow(line, candidate) && ENTRY_DATE.test(candidate.text)
    );
    const largerThanBody = line.box.height >= nearbyBody.box.height * HEADING_SETTINGS.largerHeightRatio;
    if (!largerThanBody && !alignedDate && !ENTRY_DATE.test(line.text)) {
      return line;
    }

    return { ...line, layoutAction: 'entry-boundary' as const };
  });
}

function hasIndependentSupport(score: HeadingScore): boolean {
  return score.signals.commonSection || score.signals.largerThanBody || score.signals.bold;
}

function titleClassification(
  line: LayoutLine,
  lines: LayoutLine[],
  usualHeight: number,
  pageIndex: number,
  pageHeight: number
): HeadingClassification | null {
  const titleAreaBottom = pageHeight * 0.2;
  if (
    pageIndex !== 0 ||
    line.box.y > titleAreaBottom ||
    line.box.height < usualHeight * 1.5
  ) {
    return null;
  }
  const topLines = lines.filter((candidate) => candidate.box.y <= titleAreaBottom);
  const largestHeight = Math.max(...topLines.map((candidate) => candidate.box.height));
  return line.box.height >= largestHeight * 0.9
    ? { role: 'document-title', confidence: 0.9 }
    : null;
}

// Classifies headings in two scoring passes. The first pass finds independently
// strong lines; the second may use another such line as repeated-style evidence.
// Only roles authorized by the layout policy set the persisted heading boolean.
function markHeadings(
  lines: LayoutLine[],
  usualHeight: number,
  usualGap: number,
  pageIndex: number,
  pageHeight: number
): LineDraft[] {
  const baseScores = lines.map((line) =>
    scoreHeading({
      text: line.text,
      height: line.box.height,
      localBodyHeight: usualHeight,
      bold: line.bold,
      bullet: line.bullet && BULLET.test(line.text),
      whitespaceAbove: hasWhitespaceAbove(line, lines, usualGap)
    })
  );
  const stylePatterns = collectHeadingStylePatterns(lines, baseScores);

  return lines.map((line, index) => {
    const repeatedStyleMatches = countRepeatedHeadingStyles(
      line,
      index,
      lines,
      stylePatterns
    );
    const score = scoreHeading({
      text: line.text,
      height: line.box.height,
      localBodyHeight: usualHeight,
      bold: line.bold,
      bullet: line.bullet && BULLET.test(line.text),
      whitespaceAbove: hasWhitespaceAbove(line, lines, usualGap),
      repeatedStyleMatches
    });
    const classification =
      titleClassification(line, lines, usualHeight, pageIndex, pageHeight) ?? score;
    const layoutAction = headingLayoutAction(classification);
    const heading = layoutAction !== 'none';
    return { ...line, heading, layoutAction, bullet: line.bullet && !heading };
  });
}

// Builds the pages of a document: lines grouped into ordered regions, with
// reading order numbered across the whole document. The usual line height and
// line gap are measured over the whole document, so every page is split by the
// same rules.
export function buildPages(pages: PositionedPage[]): ParsedPage[] {
  return buildPagesInternal(pages, false).pages;
}

function traceRegion(draft: RegionDraft): LayoutTraceRegion {
  return {
    box: unionBox(draft.lines.map((line) => line.box)),
    confidence: draft.confidence === null ? null : round(draft.confidence),
    lines: draft.lines
  };
}

export function buildPagesWithTrace(
  pages: PositionedPage[]
): { pages: ParsedPage[]; trace: LayoutTrace } {
  const built = buildPagesInternal(pages, true);
  if (!built.trace) {
    throw new Error('Layout trace was not collected');
  }
  return { pages: built.pages, trace: built.trace };
}

function buildPagesInternal(
  pages: PositionedPage[],
  collectTrace: boolean
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
      nonTextBoundaryCandidates: candidates.nonText,
      pageIndex,
      pageWidth: page.width,
      pageHeight: page.height
    });
    const lines = markHeadings(
      pageLines[pageIndex]!,
      usualHeight,
      usualGap,
      pageIndex,
      page.height
    );
    const entries = markEntryBoundaries(lines, usualHeight);
    const splitDrafts = splitRegion(entries, null, usualGap);
    const drafts = applySectionOwnership(splitDrafts, usualHeight);
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
        classifiedLines: entries,
        splitRegions: splitDrafts.map(traceRegion),
        ownedRegions: drafts.map(traceRegion)
      });
    }
    const regions: Region[] = drafts.map(
      (draft, index) => ({
        index,
        box: unionBox(draft.lines.map((line) => line.box)),
        confidence: draft.confidence === null ? null : round(draft.confidence),
        lines: draft.lines.map(({ layoutAction: _layoutAction, ...line }) => ({
          order: ++order,
          ...line
        }))
      })
    );
    return { ...page, regions };
  });

  return {
    pages: parsedPages,
    trace: collectTrace
      ? { usualHeight: round(usualHeight), usualGap: round(usualGap), pages: tracePages }
      : null
  };
}
