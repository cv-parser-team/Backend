import type {
  BoundaryCandidate,
  NonTextBoundaryCandidate
} from './boundary-candidates.js';
import type { LayoutLine, PageMetrics } from './layout.js';
import type { BoundingBox } from './parsing.types.js';

export type LayoutZoneKind =
  | 'full-width-section'
  | 'sidebar-main'
  | 'parallel-columns';

export type LayoutZonePartLabel =
  | 'full-width-section'
  | 'left-lane'
  | 'right-lane';

export interface LayoutZonePart {
  label: LayoutZonePartLabel;
  box: BoundingBox;
  lineIndexes: number[];
}

export interface LayoutZoneCandidate {
  kind: LayoutZoneKind;
  box: BoundingBox;
  boundaryBox: BoundingBox | null;
  confidence: number;
  reasons: string[];
  participatingLineIndexes: number[];
  parts: LayoutZonePart[];
}

export interface LayoutZoneCandidateInput {
  lines: LayoutLine[];
  metrics: PageMetrics;
  boundaryCandidates: BoundaryCandidate[];
  nonTextBoundaryCandidates: NonTextBoundaryCandidate[];
}

const DATE = /(?:\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bpresent\b)/iu;
const CONTACT = /(?:@|https?:\/\/|www\.|\+?\d[\d ().-]{6,}\d)/iu;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
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

function part(
  label: LayoutZonePartLabel,
  lines: LayoutLine[],
  indexes: number[]
): LayoutZonePart {
  return { label, box: unionBox(lines, indexes), lineIndexes: indexes };
}

function geometricLanePart(
  label: Extract<LayoutZonePartLabel, 'left-lane' | 'right-lane'>,
  box: BoundingBox,
  indexes: number[]
): LayoutZonePart {
  return { label, box, lineIndexes: indexes };
}

function horizontalEvidence(
  candidates: NonTextBoundaryCandidate[]
): NonTextBoundaryCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.kind === 'horizontal-band' ||
      (candidate.kind === 'separator' && candidate.box.width >= candidate.box.height)
  );
}

function coverage(candidate: NonTextBoundaryCandidate, activeBox: BoundingBox): number {
  return activeBox.width === 0 ? 0 : clamp(candidate.box.width / activeBox.width);
}

function nearestHorizontalBoundary(
  y: number,
  candidates: NonTextBoundaryCandidate[],
  activeBox: BoundingBox,
  direction: 'after' | 'around',
  maximumDistance: number
): NonTextBoundaryCandidate | null {
  return horizontalEvidence(candidates)
    .filter((candidate) => {
      const distance = candidate.box.y - y;
      return (
        coverage(candidate, activeBox) >= 0.6 &&
        candidate.evidence.score >= 0.45 &&
        (direction === 'after'
          ? distance >= 0 && distance <= maximumDistance
          : Math.abs(distance) <= maximumDistance)
      );
    })
    .sort((a, b) => Math.abs(a.box.y - y) - Math.abs(b.box.y - y))[0] ?? null;
}

function fullWidthSectionCandidates(input: LayoutZoneCandidateInput): LayoutZoneCandidate[] {
  const activeBox = input.metrics.activeContentBox;
  if (!activeBox) {
    return [];
  }
  return input.boundaryCandidates.flatMap((candidate) => {
    if (candidate.section.score < 0.65) {
      return [];
    }
    const line = input.lines[candidate.lineIndex]!;
    const usesLearnedSectionEvidence = candidate.section.reasons.some(
      (reason) =>
        reason === 'exact common section heading' ||
        reason.startsWith('style matches ')
    );
    const boundaryCandidates = usesLearnedSectionEvidence
      ? input.nonTextBoundaryCandidates.filter((item) => item.kind === 'separator')
      : input.nonTextBoundaryCandidates;
    const boundary = nearestHorizontalBoundary(
      centerY(line.box),
      boundaryCandidates,
      activeBox,
      'around',
      Math.max(input.metrics.usualBodyHeight * 3, input.metrics.usualVerticalGap * 3)
    );
    if (!boundary) {
      return [];
    }
    const sameRow = input.lines
      .map((other, index) => ({ other, index }))
      .filter(
        ({ other }) =>
          Math.abs(centerY(other.box) - centerY(line.box)) <=
          Math.min(other.box.height, line.box.height) / 2
      )
      .map(({ index }) => index);
    if (sameRow.length > 1) {
      return [];
    }
    const confidence = clamp(
      candidate.section.score * 0.55 +
      boundary.evidence.score * 0.3 +
      coverage(boundary, activeBox) * 0.15
    );
    return [{
      kind: 'full-width-section' as const,
      box: {
        x: activeBox.x,
        y: Math.min(line.box.y, boundary.box.y),
        width: activeBox.width,
        height: round(Math.max(bottom(line.box), bottom(boundary.box)) - Math.min(line.box.y, boundary.box.y))
      },
      boundaryBox: boundary.box,
      confidence: round(confidence),
      reasons: [
        `section candidate scored ${candidate.section.score}`,
        'nearby horizontal evidence spans the active content width'
      ],
      participatingLineIndexes: sameRow,
      parts: [part('full-width-section', input.lines, sameRow)]
    }];
  });
}

function metadataShare(indexes: number[], lines: LayoutLine[]): number {
  if (indexes.length === 0) {
    return 0;
  }
  return indexes.filter(
    (index) => DATE.test(lines[index]!.text) || CONTACT.test(lines[index]!.text)
  ).length / indexes.length;
}

function laneWidth(indexes: number[], lines: LayoutLine[]): number {
  const box = unionBox(lines, indexes);
  return box.width;
}

function hasIndependentSectionCandidate(
  indexes: number[],
  candidates: BoundaryCandidate[]
): boolean {
  return indexes.some(
    (index) => {
      const candidate = candidates[index];
      return candidate !== undefined &&
        candidate.section.score >= 0.6 &&
        (
          candidate.section.reasons.includes('exact common section heading') ||
          candidate.section.score - candidate.entry.score >= 0.3
        );
    }
  );
}

function gutterZoneCandidate(
  input: LayoutZoneCandidateInput,
  gutter: NonTextBoundaryCandidate
): LayoutZoneCandidate | null {
  const activeBox = input.metrics.activeContentBox;
  if (!activeBox) {
    return null;
  }
  const gutterRight = right(gutter.box);
  const domainTop = Math.max(activeBox.y, gutter.box.y);
  const domainBottom = Math.min(bottom(activeBox), bottom(gutter.box));
  const domainLines = input.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => centerY(line.box) >= domainTop && centerY(line.box) <= domainBottom);
  if (domainBottom <= domainTop) {
    return null;
  }
  const leftIndexes = input.lines
    .map((_, index) => index)
    .filter((index) =>
      domainLines.some((candidate) => candidate.index === index) &&
      right(input.lines[index]!.box) <= gutter.box.x + 3
    );
  const rightIndexes = input.lines
    .map((_, index) => index)
    .filter((index) =>
      domainLines.some((candidate) => candidate.index === index) &&
      input.lines[index]!.box.x >= gutterRight - 3
    );
  const crossingIndexes = input.lines
    .map((_, index) => index)
    .filter(
      (index) =>
        domainLines.some((candidate) => candidate.index === index) &&
        input.lines[index]!.box.x < gutterRight && right(input.lines[index]!.box) > gutter.box.x
    );
  if (leftIndexes.length < 2 || rightIndexes.length < 2) {
    return null;
  }

  // Crossing lines deliberately participate in both visual lane parts. A
  // provisional gutter can describe geometry but cannot partition ownership.
  const leftPartIndexes = [...new Set([...leftIndexes, ...crossingIndexes])].sort((a, b) => a - b);
  const rightPartIndexes = [...new Set([...rightIndexes, ...crossingIndexes])].sort((a, b) => a - b);
  const leftWidth = laneWidth(leftIndexes, input.lines);
  const rightWidth = laneWidth(rightIndexes, input.lines);
  const narrowerShare = Math.min(leftWidth, rightWidth) / Math.max(leftWidth + rightWidth, 1);
  const support = Math.min(1, Math.min(leftIndexes.length, rightIndexes.length) / 4);
  const crossingShare = crossingIndexes.length / Math.max(domainLines.length, 1);
  const leftMetadata = metadataShare(leftIndexes, input.lines);
  const rightMetadata = metadataShare(rightIndexes, input.lines);
  const metadataRail = Math.max(leftMetadata, rightMetadata) >= 0.5;
  const independentSections =
    hasIndependentSectionCandidate(leftIndexes, input.boundaryCandidates) &&
    hasIndependentSectionCandidate(rightIndexes, input.boundaryCandidates);
  const comparableWidths = narrowerShare >= 0.3;
  const narrowLane = narrowerShare <= 0.28;

  const reasons = [
    `gutter evidence scored ${gutter.evidence.score}`,
    `${leftIndexes.length} left-lane and ${rightIndexes.length} right-lane lines`
  ];
  let sidebarScore = gutter.evidence.score * 0.35 + support * 0.25;
  if (narrowLane) {
    sidebarScore += 0.25;
    reasons.push('one lane is consistently narrow');
  }
  if (crossingShare <= 0.2) {
    sidebarScore += 0.1;
  }
  let parallelScore = gutter.evidence.score * 0.35 + support * 0.2;
  if (independentSections) {
    parallelScore += 0.3;
    reasons.push('both lanes have independent section candidates');
  }
  if (comparableWidths) {
    parallelScore += 0.1;
    reasons.push('lane widths are comparable');
  }
  if (crossingShare <= 0.2) {
    parallelScore += 0.05;
  }
  if (metadataRail) {
    sidebarScore -= 0.25;
    parallelScore -= 0.2;
    reasons.push('metadata-heavy lane may describe content across the gutter');
  }

  sidebarScore = clamp(sidebarScore);
  parallelScore = clamp(parallelScore);
  let kind: LayoutZoneKind | null = null;
  let confidence = Math.max(sidebarScore, parallelScore, gutter.evidence.score * 0.45);
  if (sidebarScore >= 0.65 && narrowLane && !metadataRail) {
    kind = 'sidebar-main';
    confidence = sidebarScore;
  } else if (
    parallelScore >= 0.65 &&
    independentSections &&
    !metadataRail
  ) {
    kind = 'parallel-columns';
    confidence = parallelScore;
  } else {
    reasons.push('insufficient evidence to confirm independent macro zones');
  }

  if (kind === null) {
    return null;
  }

  const participating = [...new Set([
    ...leftIndexes,
    ...rightIndexes,
    ...crossingIndexes
  ])].sort((a, b) => a - b);
  return {
    kind,
    box: {
      x: activeBox.x,
      y: round(domainTop),
      width: activeBox.width,
      height: round(domainBottom - domainTop)
    },
    boundaryBox: gutter.box,
    confidence: round(confidence),
    reasons,
    participatingLineIndexes: participating,
    parts: [
      geometricLanePart('left-lane', {
        x: activeBox.x,
        y: round(domainTop),
        width: round(Math.max(0, gutter.box.x - activeBox.x)),
        height: round(domainBottom - domainTop)
      }, leftPartIndexes),
      geometricLanePart('right-lane', {
        x: gutterRight,
        y: round(domainTop),
        width: round(Math.max(0, right(activeBox) - gutterRight)),
        height: round(domainBottom - domainTop)
      }, rightPartIndexes)
    ]
  };
}

export function generateLayoutZoneCandidates(
  input: LayoutZoneCandidateInput
): LayoutZoneCandidate[] {
  if (input.lines.length === 0 || !input.metrics.activeContentBox) {
    return [];
  }
  const fullWidthSections = fullWidthSectionCandidates(input);
  const gutterZones = input.nonTextBoundaryCandidates
    .filter(
      (candidate) =>
        (candidate.kind === 'vertical-gutter' && candidate.evidence.score >= 0.55) ||
        (candidate.kind === 'separator' &&
          candidate.box.height > candidate.box.width &&
          candidate.evidence.score >= 0.55)
    )
    .map((candidate) => gutterZoneCandidate(input, candidate))
    .filter((candidate): candidate is LayoutZoneCandidate => candidate !== null)
    .sort((a, b) => a.box.height - b.box.height || b.confidence - a.confidence);
  return [
    ...fullWidthSections,
    ...gutterZones
  ];
}
