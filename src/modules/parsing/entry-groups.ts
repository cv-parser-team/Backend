import type { BoundaryCandidate } from './boundary-candidates.js';
import type { LayoutLine, PageMetrics } from './layout.js';
import type { SectionScope } from './section-scopes.js';
import type { BoundingBox } from './parsing.types.js';
import { normalizeSemanticText } from './semantic-text.js';

export interface ResolvedEntryAnchor {
  lineIndex: number;
  sectionHeadingLineIndex: number;
  confidence: number;
  reasons: string[];
  demotedSectionCandidate: boolean;
}

export interface EntryGroup {
  anchorLineIndex: number;
  sectionHeadingLineIndex: number;
  lineIndexes: number[];
  box: BoundingBox;
  confidence: number;
}

export interface EntryResolution {
  anchors: ResolvedEntryAnchor[];
  groups: EntryGroup[];
}

interface EntryResolutionInput {
  lines: LayoutLine[];
  metrics: PageMetrics;
  boundaryCandidates: BoundaryCandidate[];
  sectionScopes: SectionScope[];
}

const METADATA = /(?:\b(?:19|20)\d{2}\b|\b(?:present|now)\b|@|https?:\/\/|www\.|\+?\d[\d ().-]{6,}\d)/iu;

function isMetadata(text: string): boolean {
  return METADATA.test(normalizeSemanticText(text));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function right(box: BoundingBox): number {
  return box.x + box.width;
}

function bottom(box: BoundingBox): number {
  return box.y + box.height;
}

function centerX(box: BoundingBox): number {
  return box.x + box.width / 2;
}

function centerY(box: BoundingBox): number {
  return box.y + box.height / 2;
}

function sharesRow(first: LayoutLine, second: LayoutLine): boolean {
  return Math.abs(centerY(first.box) - centerY(second.box)) <=
    Math.min(first.box.height, second.box.height) / 2;
}

function unionBox(lines: LayoutLine[], indexes: number[]): BoundingBox {
  const boxes = indexes.map((index) => lines[index]!.box);
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const rightEdge = Math.max(...boxes.map(right));
  const bottomEdge = Math.max(...boxes.map(bottom));
  return {
    x: round(left),
    y: round(top),
    width: round(rightEdge - left),
    height: round(bottomEdge - top)
  };
}

function styleKey(line: LayoutLine, bodyHeight: number): string {
  return [line.bold ? 'bold' : 'regular', Math.round(line.box.height / Math.max(bodyHeight, 1))]
    .join(':');
}

function anchorsInScope(
  scope: SectionScope,
  input: EntryResolutionInput
): ResolvedEntryAnchor[] {
  const candidates = scope.lineIndexes
    .filter((lineIndex) => lineIndex !== scope.headingLineIndex)
    .map((lineIndex) => ({
      lineIndex,
      line: input.lines[lineIndex]!,
      candidate: input.boundaryCandidates[lineIndex]!
    }));
  const styleCounts = new Map<string, number>();
  for (const { line, candidate } of candidates) {
    if (line.bold && candidate.entry.score >= 0.2 && !isMetadata(line.text)) {
      const key = styleKey(line, input.metrics.usualBodyHeight);
      styleCounts.set(key, (styleCounts.get(key) ?? 0) + 1);
    }
  }
  const provisionalHeadings = new Set(
    input.sectionScopes
      .filter((candidate) =>
        candidate.status === 'provisional' &&
        candidate.headingLineIndex !== scope.headingLineIndex &&
        scope.lineIndexes.includes(candidate.headingLineIndex) &&
        input.boundaryCandidates[candidate.headingLineIndex]!.entry.score >
          input.boundaryCandidates[candidate.headingLineIndex]!.section.score
      )
      .map((candidate) => candidate.headingLineIndex)
  );
  return candidates.flatMap(({ lineIndex, line, candidate }) => {
    const repeatedStyle = !isMetadata(line.text) &&
      (styleCounts.get(styleKey(line, input.metrics.usualBodyHeight)) ?? 0) >= 2;
    const demoted = provisionalHeadings.has(lineIndex);
    const strongAnchor = line.bold && candidate.entry.score >= 0.7 && !isMetadata(line.text);
    const precedingBoldLine = candidates
      .filter(({ line: other }) =>
        other.box.y < line.box.y &&
        Math.abs(other.box.x - line.box.x) <= 3 &&
        other.bold &&
        Math.abs(other.box.height - line.box.height) <= 1
      )
      .sort((a, b) => b.line.box.y - a.line.box.y)[0];
    const continuesBoldAnchor = precedingBoldLine !== undefined &&
      line.box.y - bottom(precedingBoldLine.line.box) <=
        Math.max(input.metrics.usualVerticalGap * 1.5, input.metrics.usualBodyHeight * 0.5);
    const headingLine = input.lines[scope.headingLineIndex]!;
    const continuesSectionHeading = demoted &&
      Math.abs(line.box.x - headingLine.box.x) <= 3 &&
      Math.abs(line.box.height - headingLine.box.height) <= 1 &&
      line.box.y - bottom(headingLine.box) <= input.metrics.usualBodyHeight;
    if (
      continuesBoldAnchor ||
      continuesSectionHeading ||
      (!demoted && !strongAnchor && !(repeatedStyle && candidate.entry.score >= 0.2))
    ) {
      return [];
    }
    const reasons = [`entry evidence scored ${candidate.entry.score}`];
    let confidence = candidate.entry.score * 0.65;
    if (repeatedStyle) {
      confidence += 0.45;
      reasons.push('anchor typography repeats inside the section');
    }
    if (demoted) {
      confidence += 0.1;
      reasons.push('context demotes a provisional section candidate to an entry anchor');
    }
    if (line.bold) {
      confidence += 0.05;
      reasons.push('bold compact anchor typography');
    }
    return [{
      lineIndex,
      sectionHeadingLineIndex: scope.headingLineIndex,
      confidence: round(Math.min(1, confidence)),
      reasons,
      demotedSectionCandidate: demoted
    }];
  });
}

function anchorRows(
  anchors: ResolvedEntryAnchor[],
  lines: LayoutLine[]
): ResolvedEntryAnchor[][] {
  const rows: ResolvedEntryAnchor[][] = [];
  for (const anchor of [...anchors].sort((a, b) =>
    lines[a.lineIndex]!.box.y - lines[b.lineIndex]!.box.y ||
    lines[a.lineIndex]!.box.x - lines[b.lineIndex]!.box.x
  )) {
    const row = rows.at(-1);
    if (row && sharesRow(lines[row[0]!.lineIndex]!, lines[anchor.lineIndex]!)) {
      row.push(anchor);
    } else {
      rows.push([anchor]);
    }
  }
  return rows;
}

function linesForAnchor(
  anchor: ResolvedEntryAnchor,
  rowIndex: number,
  rows: ResolvedEntryAnchor[][],
  scope: SectionScope,
  lines: LayoutLine[]
): number[] {
  const row = rows[rowIndex]!;
  const anchorLine = lines[anchor.lineIndex]!;
  const nextRow = rows[rowIndex + 1];
  const rowY = Math.min(...row.map((candidate) => lines[candidate.lineIndex]!.box.y));
  const startY = Math.max(
    bottom(lines[scope.headingLineIndex]!.box),
    rowY - anchorLine.box.height
  );
  const endY = nextRow
    ? Math.min(...nextRow.map((candidate) =>
        lines[candidate.lineIndex]!.box.y - lines[candidate.lineIndex]!.box.height
      ))
    : Number.POSITIVE_INFINITY;
  const rowHasCards = row.length > 1;
  const owned = scope.lineIndexes.filter((lineIndex) => {
    if (lineIndex === scope.headingLineIndex) {
      return false;
    }
    const line = lines[lineIndex]!;
    if (line.box.y < startY || line.box.y >= endY) {
      return false;
    }
    if (!rowHasCards) {
      return true;
    }
    const nearest = [...row].sort((a, b) =>
      Math.abs(centerX(lines[a.lineIndex]!.box) - centerX(line.box)) -
      Math.abs(centerX(lines[b.lineIndex]!.box) - centerX(line.box))
    )[0];
    return nearest?.lineIndex === anchor.lineIndex;
  });
  return [...new Set([anchor.lineIndex, ...owned])].sort((a, b) => a - b);
}

export function resolveEntries(
  input: EntryResolutionInput
): EntryResolution {
  const confirmedScopes = input.sectionScopes.filter((scope) => scope.status === 'confirmed');
  const anchors = confirmedScopes.flatMap((scope) => anchorsInScope(scope, input));
  const groups: EntryGroup[] = [];
  for (const scope of confirmedScopes) {
    const scopeAnchors = anchors.filter(
      (anchor) => anchor.sectionHeadingLineIndex === scope.headingLineIndex
    );
    const rows = anchorRows(scopeAnchors, input.lines);
    rows.forEach((row, rowIndex) => {
      for (const anchor of row) {
        const lineIndexes = linesForAnchor(
          anchor,
          rowIndex,
          rows,
          scope,
          input.lines
        );
        groups.push({
          anchorLineIndex: anchor.lineIndex,
          sectionHeadingLineIndex: scope.headingLineIndex,
          lineIndexes,
          box: unionBox(input.lines, lineIndexes),
          confidence: anchor.confidence
        });
      }
    });
  }
  return { anchors, groups };
}
