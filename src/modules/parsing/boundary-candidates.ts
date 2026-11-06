import type { LayoutLine, PageMetrics, WhitespaceCandidate } from './layout.js';
import type { BoundingBox, DrawnSeparator } from './parsing.types.js';

export interface ScoredEvidence {
  score: number;
  reasons: string[];
}

export interface BoundaryCandidate {
  lineIndex: number;
  header: ScoredEvidence;
  section: ScoredEvidence;
  entry: ScoredEvidence;
  content: ScoredEvidence;
}

export type NonTextBoundaryKind =
  | 'vertical-gutter'
  | 'horizontal-band'
  | 'separator'
  | 'alignment-change';

export interface NonTextBoundaryCandidate {
  kind: NonTextBoundaryKind;
  box: BoundingBox;
  evidence: ScoredEvidence;
}

export interface BoundaryCandidateInput {
  lines: LayoutLine[];
  metrics: PageMetrics;
  separators: DrawnSeparator[];
  pageIndex: number;
  pageHeight: number;
}

const DATE = /(?:\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bpresent\b)/iu;
const CONTACT = /(?:@|https?:\/\/|www\.|\+?\d[\d ().-]{6,}\d)/iu;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(clamp(value) * 100) / 100;
}

function evidence(score: number, reasons: string[]): ScoredEvidence {
  return { score: roundScore(score), reasons };
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

function overlapsHorizontally(first: BoundingBox, second: BoundingBox): boolean {
  return first.x < right(second) && second.x < right(first);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function hasSentenceShape(line: LayoutLine): boolean {
  return wordCount(line.text) >= 12 || /[.!?]$/u.test(line.text.trim());
}

function whitespaceAbove(line: LayoutLine, lines: LayoutLine[], usualGap: number): boolean {
  const bottoms = lines
    .filter(
      (candidate) =>
        candidate !== line &&
        candidate.box.y + candidate.box.height <= line.box.y &&
        overlapsHorizontally(candidate.box, line.box)
    )
    .map((candidate) => candidate.box.y + candidate.box.height);
  if (bottoms.length === 0) {
    return false;
  }
  return line.box.y - Math.max(...bottoms) >= Math.max(usualGap * 2, line.box.height * 0.5);
}

function sameVisualStyle(first: LayoutLine, second: LayoutLine): boolean {
  return (
    first.bold === second.bold &&
    first.italic === second.italic &&
    Math.abs(first.box.height - second.box.height) <=
      Math.max(0.5, Math.min(first.box.height, second.box.height) * 0.08)
  );
}

function repeatedStyleMatches(line: LayoutLine, lines: LayoutLine[]): number {
  return lines.filter(
    (candidate) =>
      candidate !== line &&
      sameVisualStyle(line, candidate) &&
      Math.abs(candidate.box.x - line.box.x) <= 3
  ).length;
}

function nearbyHorizontalSeparator(
  line: LayoutLine,
  separators: DrawnSeparator[],
  metrics: PageMetrics
): { separator: DrawnSeparator; coverage: number } | null {
  for (let index = 0; index < separators.length; index++) {
    const separator = separators[index]!;
    if (separator.orientation !== 'horizontal' || !overlapsHorizontally(line.box, separator.box)) {
      continue;
    }
    const verticalDistance = Math.min(
      Math.abs(separator.box.y - (line.box.y + line.box.height)),
      Math.abs(line.box.y - (separator.box.y + separator.box.height))
    );
    if (verticalDistance <= line.box.height * 1.5) {
      return {
        separator,
        coverage: metrics.separatorCoverage.find((item) => item.separatorIndex === index)?.coverage ?? 0
      };
    }
  }
  return null;
}

function followingBody(line: LayoutLine, lines: LayoutLine[]): boolean {
  return lines.some((candidate) => {
    if (candidate === line || candidate.box.y < line.box.y) {
      return false;
    }
    const gap = candidate.box.y - (line.box.y + line.box.height);
    return (
      gap <= Math.max(line.box.height, candidate.box.height) * 2 &&
      !candidate.bold &&
      !candidate.bullet &&
      !DATE.test(candidate.text) &&
      !CONTACT.test(candidate.text)
    );
  });
}

function alignedMetadata(line: LayoutLine, lines: LayoutLine[]): boolean {
  return lines.some(
    (candidate) =>
      candidate !== line &&
      sharesRow(line, candidate) &&
      (DATE.test(candidate.text) || CONTACT.test(candidate.text))
  );
}

function scoreLineCandidate(
  line: LayoutLine,
  lines: LayoutLine[],
  metrics: PageMetrics,
  separators: DrawnSeparator[],
  pageIndex: number,
  pageHeight: number
): Omit<BoundaryCandidate, 'lineIndex'> {
  const words = wordCount(line.text);
  const short = words > 0 && words <= 8;
  const bodyHeight = metrics.usualBodyHeight;
  const larger = bodyHeight > 0 && line.box.height >= bodyHeight * 1.15;
  const titleSized = bodyHeight > 0 && line.box.height >= bodyHeight * 1.5;
  const inTitleArea = pageIndex === 0 && line.box.y <= pageHeight * 0.2;
  const spacedAbove = whitespaceAbove(line, lines, metrics.usualVerticalGap);
  const repeated = repeatedStyleMatches(line, lines);
  const sentence = hasSentenceShape(line);
  const date = DATE.test(line.text);
  const contact = CONTACT.test(line.text);
  const separator = nearbyHorizontalSeparator(line, separators, metrics);

  let headerScore = 0;
  const headerReasons: string[] = [];
  if (inTitleArea) {
    headerScore += 0.4;
    headerReasons.push('within the first-page title area');
  }
  if (titleSized) {
    headerScore += 0.4;
    headerReasons.push('at least 1.5× the usual body height');
  }
  if (line.bold) {
    headerScore += 0.1;
    headerReasons.push('bold typography');
  }
  if (short) {
    headerScore += 0.1;
    headerReasons.push('compact text');
  }
  if (line.bullet || date || contact || sentence) {
    headerScore -= 0.45;
    headerReasons.push('body, metadata, or list shape reduces header authority');
  }

  let sectionScore = 0;
  const sectionReasons: string[] = [];
  if (larger) {
    sectionScore += 0.3;
    sectionReasons.push('larger than the usual body line');
  }
  if (line.bold) {
    sectionScore += 0.2;
    sectionReasons.push('bold typography');
  }
  if (short) {
    sectionScore += 0.1;
    sectionReasons.push('compact text');
  }
  if (spacedAbove) {
    sectionScore += 0.2;
    sectionReasons.push('supporting whitespace above');
  }
  if (repeated > 0) {
    sectionScore += Math.min(0.2, repeated * 0.08);
    sectionReasons.push(`style repeats ${repeated} time${repeated === 1 ? '' : 's'} in the same lane`);
  }
  if (separator) {
    sectionScore += 0.05 + separator.coverage * 0.1;
    sectionReasons.push('nearby horizontal separator');
  }
  if (inTitleArea && titleSized) {
    sectionScore -= 0.2;
    sectionReasons.push('title-area prominence reduces section authority');
  }
  if (line.bullet || date || contact || sentence) {
    sectionScore -= 0.45;
    sectionReasons.push('body, metadata, or list shape reduces section authority');
  }

  let entryScore = 0;
  const entryReasons: string[] = [];
  if (line.bold) {
    entryScore += 0.25;
    entryReasons.push('bold anchor typography');
  }
  if (short) {
    entryScore += 0.15;
    entryReasons.push('compact anchor text');
  }
  if (repeated > 0) {
    entryScore += Math.min(0.25, repeated * 0.1);
    entryReasons.push(`anchor style repeats ${repeated} time${repeated === 1 ? '' : 's'} in the same lane`);
  }
  if (alignedMetadata(line, lines)) {
    entryScore += 0.2;
    entryReasons.push('aligned date or contact metadata');
  }
  if (followingBody(line, lines)) {
    entryScore += 0.15;
    entryReasons.push('nearby following body text');
  }
  if (spacedAbove) {
    entryScore += 0.1;
    entryReasons.push('entry-sized whitespace above');
  }
  if (inTitleArea && titleSized) {
    entryScore -= 0.3;
    entryReasons.push('title-area prominence reduces entry authority');
  }
  if (line.bullet || date || contact || sentence) {
    entryScore -= 0.5;
    entryReasons.push('body, metadata, or list shape reduces entry authority');
  }

  let contentScore = 0;
  const contentReasons: string[] = [];
  if (!larger) {
    contentScore += 0.3;
    contentReasons.push('body-sized typography');
  }
  if (!line.bold) {
    contentScore += 0.2;
    contentReasons.push('regular weight');
  }
  if (sentence) {
    contentScore += 0.25;
    contentReasons.push('sentence or paragraph shape');
  }
  if (line.bullet) {
    contentScore += 0.2;
    contentReasons.push('list-item shape');
  }
  if (date || contact) {
    contentScore += 0.2;
    contentReasons.push('metadata shape');
  }
  if (!short) {
    contentScore += 0.1;
    contentReasons.push('longer than a compact anchor');
  }

  return {
    header: evidence(headerScore, headerReasons),
    section: evidence(sectionScore, sectionReasons),
    entry: evidence(entryScore, entryReasons),
    content: evidence(contentScore, contentReasons)
  };
}

function scoreWhitespaceCandidate(
  kind: 'vertical-gutter' | 'horizontal-band',
  candidate: WhitespaceCandidate,
  metrics: PageMetrics
): NonTextBoundaryCandidate {
  const usualSize = kind === 'vertical-gutter'
    ? metrics.usualBodyHeight
    : metrics.usualVerticalGap || metrics.usualBodyHeight * 0.3;
  const sizeRatio = usualSize > 0 ? candidate.size / usualSize : 0;
  const score = 0.25 + candidate.coverage * 0.35 + Math.min(0.4, sizeRatio * 0.1);
  return {
    kind,
    box: candidate.box,
    evidence: evidence(score, [
      `${candidate.coverage} empty-band coverage`,
      `${candidate.size}pt ${kind === 'vertical-gutter' ? 'width' : 'height'}`
    ])
  };
}

function scoreSeparator(
  separator: DrawnSeparator,
  separatorIndex: number,
  lines: LayoutLine[],
  metrics: PageMetrics,
  separators: DrawnSeparator[]
): NonTextBoundaryCandidate {
  const coverage = metrics.separatorCoverage.find(
    (item) => item.separatorIndex === separatorIndex
  )?.coverage ?? 0;
  const thin = separator.thickness <= Math.max(1, metrics.usualBodyHeight * 0.2);
  const above = lines.some((line) => line.box.y + line.box.height <= separator.box.y);
  const below = lines.some((line) => line.box.y >= separator.box.y + separator.box.height);
  const parallel = separators.filter(
    (candidate) =>
      candidate !== separator &&
      candidate.orientation === separator.orientation &&
      Math.abs(candidate.box.x - separator.box.x) <= 3 &&
      Math.abs(candidate.box.width - separator.box.width) <= 3
  ).length;
  let score = 0;
  const reasons: string[] = [];
  if (thin) {
    score += 0.2;
    reasons.push('thin relative to body text');
  }
  if (coverage >= 0.25) {
    score += Math.min(0.4, coverage * 0.4);
    reasons.push(`${coverage} active-content coverage`);
  }
  if (above && below) {
    score += coverage >= 0.25 ? 0.25 : 0.05;
    reasons.push(
      coverage >= 0.25
        ? 'positioned between text groups'
        : 'short rule between text groups has limited authority'
    );
  }
  if (separator.orientation === 'horizontal') {
    score += 0.05;
    reasons.push('horizontal orientation');
  }
  if (parallel >= 2) {
    score -= 0.35;
    reasons.push('repeated parallel rules suggest a table or card');
  }
  return { kind: 'separator', box: separator.box, evidence: evidence(score, reasons) };
}

function alignmentChangeCandidates(
  lines: LayoutLine[],
  metrics: PageMetrics
): NonTextBoundaryCandidate[] {
  const supportedEdges = metrics.leftEdges.filter((cluster) => cluster.count >= 2);
  const sorted = [...lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const candidates: NonTextBoundaryCandidate[] = [];
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (sharesRow(previous, current)) {
      continue;
    }
    const previousEdge = supportedEdges.find((edge) => Math.abs(edge.value - previous.box.x) <= 3);
    const currentEdge = supportedEdges.find((edge) => Math.abs(edge.value - current.box.x) <= 3);
    const shift = Math.abs(current.box.x - previous.box.x);
    if (!previousEdge || !currentEdge || previousEdge === currentEdge || shift < metrics.usualBodyHeight * 2) {
      continue;
    }
    candidates.push({
      kind: 'alignment-change',
      box: {
        x: metrics.activeContentBox?.x ?? 0,
        y: current.box.y,
        width: metrics.activeContentBox?.width ?? 0,
        height: 1
      },
      evidence: evidence(0.35 + Math.min(0.35, shift / 300), [
        `${Math.round(shift * 100) / 100}pt left-edge shift`,
        'both alignments repeat on the page'
      ])
    });
  }
  return candidates.filter(
    (candidate, index, all) =>
      all.findIndex((other) => Math.abs(other.box.y - candidate.box.y) <= 3) === index
  );
}

export function generateBoundaryCandidates(
  input: BoundaryCandidateInput
): { lines: BoundaryCandidate[]; nonText: NonTextBoundaryCandidate[] } {
  const lineCandidates = input.lines.map((line, lineIndex) => ({
    lineIndex,
    ...scoreLineCandidate(
      line,
      input.lines,
      input.metrics,
      input.separators,
      input.pageIndex,
      input.pageHeight
    )
  }));
  const nonText = [
    ...input.metrics.verticalGutters.map((candidate) =>
      scoreWhitespaceCandidate('vertical-gutter', candidate, input.metrics)
    ),
    ...input.metrics.horizontalBands.map((candidate) =>
      scoreWhitespaceCandidate('horizontal-band', candidate, input.metrics)
    ),
    ...input.separators.map((separator, separatorIndex) =>
      scoreSeparator(separator, separatorIndex, input.lines, input.metrics, input.separators)
    ),
    ...alignmentChangeCandidates(input.lines, input.metrics)
  ];
  return { lines: lineCandidates, nonText };
}
