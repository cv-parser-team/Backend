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
const DATE = /(?:\b(?:19|20)\d{2}\b|\b(?:present|now)\b)/iu;

function isMetadata(text: string): boolean {
  return METADATA.test(normalizeSemanticText(text));
}

function isDate(text: string): boolean {
  return DATE.test(normalizeSemanticText(text));
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
  return [
    line.bold ? 'bold' : 'regular',
    line.italic ? 'italic' : 'upright',
    line.bullet ? 'bullet' : 'plain',
    Math.round(line.box.height / Math.max(bodyHeight, 1))
  ]
    .join(':');
}

function hasAssociatedDate(
  line: LayoutLine,
  candidates: Array<{ line: LayoutLine }>,
  metrics: PageMetrics
): boolean {
  const maximumDistance = Math.max(
    metrics.usualBodyHeight * 6,
    metrics.usualVerticalGap * 8,
    80
  );
  return candidates.some(({ line: other }) => {
    if (other === line || !isDate(other.text)) {
      return false;
    }
    if (sharesRow(line, other)) {
      return true;
    }
    return other.box.y > line.box.y &&
      other.box.y - line.box.y <= maximumDistance &&
      Math.abs(other.box.x - line.box.x) <= 3;
  });
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
  const stylePositions = new Map<string, number[]>();
  for (const { line, candidate } of candidates) {
    const anchorTypography = line.bold || line.italic || line.bullet;
    if (anchorTypography && candidate.entry.score >= 0.15 && !isMetadata(line.text)) {
      const key = styleKey(line, input.metrics.usualBodyHeight);
      stylePositions.set(key, [...(stylePositions.get(key) ?? []), line.box.y]);
    }
  }
  return candidates.flatMap(({ lineIndex, line, candidate }) => {
    const anchorTypography = line.bold || line.italic || line.bullet;
    const positions = stylePositions.get(styleKey(line, input.metrics.usualBodyHeight)) ?? [];
    const repeatedAtEntrySpacing = positions.length >= 2 &&
      (line.bold ||
        (positions.at(-1)! - positions[0]!) / (positions.length - 1) >=
          input.metrics.usualBodyHeight * 3);
    const repeatedStyle = !isMetadata(line.text) && repeatedAtEntrySpacing;
    const strongAnchor = anchorTypography &&
      candidate.entry.score >= 0.7 &&
      !isMetadata(line.text);
    const semanticEntryFallback =
      !anchorTypography &&
      (scope.kind === 'experience' || scope.kind === 'education') &&
      candidate.entry.score >= 0.65 &&
      line.box.height >= input.metrics.usualBodyHeight * 1.15 &&
      candidate.entry.reasons.includes('entry-sized whitespace above') &&
      !isMetadata(line.text) &&
      hasAssociatedDate(line, candidates, input.metrics);
    const precedingAnchorLine = candidates
      .filter(({ line: other }) =>
        other.box.y < line.box.y &&
        Math.abs(other.box.x - line.box.x) <= 3 &&
        (other.bold || other.italic || other.bullet) &&
        Math.abs(other.box.height - line.box.height) <= 2
      )
      .sort((a, b) => b.line.box.y - a.line.box.y)[0];
    const precedingAnchorHasMetadata = precedingAnchorLine !== undefined && candidates.some(
      ({ line: other }) =>
        other !== precedingAnchorLine.line &&
        sharesRow(other, precedingAnchorLine.line) &&
        isMetadata(other.text)
    );
    const lineHasMetadata = candidates.some(
      ({ line: other }) => other !== line && sharesRow(other, line) && isMetadata(other.text)
    );
    const verticalGap = precedingAnchorLine === undefined
      ? Number.POSITIVE_INFINITY
      : line.box.y - bottom(precedingAnchorLine.line.box);
    const continuesAnchor = precedingAnchorLine !== undefined && (
      verticalGap <= Math.max(
        input.metrics.usualVerticalGap * 1.5,
        input.metrics.usualBodyHeight * 0.5
      ) || (
        precedingAnchorHasMetadata &&
        !lineHasMetadata &&
        verticalGap <= Math.max(
          input.metrics.usualVerticalGap * 3,
          input.metrics.usualBodyHeight * 1.25
        )
      )
    );
    if (
      continuesAnchor ||
      (
        !strongAnchor &&
        !semanticEntryFallback &&
        !(anchorTypography && repeatedStyle && candidate.entry.score >= 0.15)
      )
    ) {
      return [];
    }
    const reasons = [`entry evidence scored ${candidate.entry.score}`];
    let confidence = candidate.entry.score * 0.65;
    if (repeatedStyle) {
      confidence += 0.45;
      reasons.push('anchor typography repeats inside the section');
    }
    if (anchorTypography) {
      confidence += 0.05;
      reasons.push('compact anchor typography');
    }
    if (semanticEntryFallback) {
      confidence += 0.2;
      reasons.push(`associated date supports regular anchor in ${scope.kind} section`);
    }
    return [{
      lineIndex,
      sectionHeadingLineIndex: scope.headingLineIndex,
      confidence: round(Math.min(1, confidence)),
      reasons,
      demotedSectionCandidate: false
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
  const rowByStart = [...row].sort((a, b) =>
    lines[a.lineIndex]!.box.x - lines[b.lineIndex]!.box.x
  );
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
    const owner = rowByStart
      .filter((candidate) => lines[candidate.lineIndex]!.box.x <= line.box.x)
      .at(-1) ?? rowByStart[0];
    return owner?.lineIndex === anchor.lineIndex;
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
