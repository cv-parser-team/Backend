import { BoundingBox, ParsedPage, Region, TextLine, TextPiece } from './parsing.types.js';

// Layout works on text pieces with page coordinates and knows nothing about
// the file format, so any source of positioned text can use it.

export interface PositionedPage {
  pageNumber: number;
  width: number;
  height: number;
  pieces: TextPiece[];
  // Small drawn shapes, such as list bullets drawn as dots.
  marks: BoundingBox[];
}

type LineDraft = Omit<TextLine, 'order'>;

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

function toLine(pieces: TextPiece[]): LineDraft {
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
    heading: false,
    bold: styledLength('bold') * 2 > text.length,
    italic: styledLength('italic') * 2 > text.length,
    bullet: BULLET.test(text.trim()),
    links: [...new Set(pieces.flatMap((piece) => piece.links))]
  };
}

// A mark no taller than the line, just before its start and level with it,
// is a list bullet drawn as a shape.
function markBullets(lines: LineDraft[], marks: BoundingBox[]): LineDraft[] {
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
// into separate lines, so columns side by side are not merged.
function groupLines(pieces: TextPiece[]): LineDraft[] {
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

function byReadingPosition(a: LineDraft, b: LineDraft): number {
  return a.box.y - b.box.y || a.box.x - b.box.x;
}

function right(box: BoundingBox): number {
  return box.x + box.width;
}

function centerY(box: BoundingBox): number {
  return box.y + box.height / 2;
}

// Gaps between consecutive lines from top to bottom; overlapping lines count
// as no gap.
function verticalGaps(lines: LineDraft[]): { gap: number; below: number }[] {
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
function lineGaps(lines: LineDraft[]): number[] {
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

// Scores a gap between left and right groups of lines from several signals.
// The gap runs through the whole region, because no line crosses it.
function scoreColumnSplit(left: LineDraft[], rightLines: LineDraft[], regionWidth: number): number {
  const settings = LAYOUT_SETTINGS;
  if (
    Math.max(shareOnSharedRows(left, rightLines), shareOnSharedRows(rightLines, left)) >=
    settings.sharedRowShare
  ) {
    return 0;
  }

  const width = (lines: LineDraft[]) =>
    Math.max(...lines.map((line) => right(line.box))) - Math.min(...lines.map((line) => line.box.x));
  const narrowerShare = Math.min(width(left), width(rightLines)) / regionWidth;
  const top = (lines: LineDraft[]) => [...lines].sort(byReadingPosition)[0]!;
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
  const middle = (gutter.left + gutter.right) / 2;
  const crossesGap = lines.some((line) => line.box.x < middle && right(line.box) > middle);
  return (
    !crossesGap &&
    lines.some((line) => right(line.box) <= middle) &&
    lines.some((line) => line.box.x >= middle)
  );
}

// A band that separates a full-width area, such as a header, from columns:
// one side has columns and the other does not. The other side is full width
// only when it crosses the column gap or sits on one side of it, such as a
// name above the main column. When both sides have columns, the columns are
// read whole instead.
function findFullWidthSplit(lines: LineDraft[], usualGap: number): Split | null {
  return findBandSplit(lines, usualGap, (parts) => {
    const [above, below] = parts.map(findColumnSplit);
    if ((above === null) === (below === null)) {
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
  return findBandSplit(lines, usualGap, (_parts, firstBelow) => firstBelow.heading);
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

  return [{ lines: [...lines].sort(byReadingPosition), confidence }];
}

// A heading is not a list item, even when a small part of an icon sits
// before it.
function markHeadings(lines: LineDraft[], usualHeight: number): LineDraft[] {
  return lines.map((line) => {
    const heading = line.box.height >= usualHeight * LAYOUT_SETTINGS.headingHeightRatio;
    return { ...line, heading, bullet: line.bullet && !heading };
  });
}

// Builds the pages of a document: lines grouped into ordered regions, with
// reading order numbered across the whole document. The usual line height and
// line gap are measured over the whole document, so every page is split by the
// same rules.
export function buildPages(pages: PositionedPage[]): ParsedPage[] {
  const pageLines = pages.map(({ pieces, marks }) => markBullets(groupLines(pieces), marks));
  const allLines = pageLines.flat();
  const usualHeight = median(allLines.map((line) => line.box.height));
  const usualGap = median(pageLines.flatMap(lineGaps)) || usualHeight * 0.3;
  let order = 0;

  return pages.map(({ pieces: _pieces, marks: _marks, ...page }, pageIndex) => {
    const lines = markHeadings(pageLines[pageIndex]!, usualHeight);
    const regions: Region[] = splitRegion(lines, null, usualGap).map(
      (draft, index) => ({
        index,
        box: unionBox(draft.lines.map((line) => line.box)),
        confidence: draft.confidence === null ? null : round(draft.confidence),
        lines: draft.lines.map((line) => ({ order: ++order, ...line }))
      })
    );
    return { ...page, regions };
  });
}
