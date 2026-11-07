import type {
  BoundaryCandidate,
  NonTextBoundaryCandidate
} from './boundary-candidates.js';
import type { LayoutLine, PageMetrics } from './layout.js';
import type { LayoutZoneCandidate, LayoutZonePart } from './macro-layout.js';
import type { BoundingBox } from './parsing.types.js';

export type SectionScopeStatus = 'confirmed' | 'provisional';
export type SectionScopeMode = 'cross-lane' | 'lane-local' | 'provisional-cell';

export interface SectionScope {
  headingLineIndex: number;
  lineIndexes: number[];
  box: BoundingBox;
  status: SectionScopeStatus;
  mode: SectionScopeMode;
  confidence: number;
  reasons: string[];
  governingZoneCandidateIndexes: number[];
}

export interface SectionScopeInput {
  lines: LayoutLine[];
  metrics: PageMetrics;
  boundaryCandidates: BoundaryCandidate[];
  nonTextBoundaryCandidates: NonTextBoundaryCandidate[];
  layoutZoneCandidates: LayoutZoneCandidate[];
}

interface ResolvedHeading {
  candidate: BoundaryCandidate;
  status: SectionScopeStatus;
  mode: SectionScopeMode;
  confidence: number;
  reasons: string[];
  zoneIndexes: number[];
  lanePart: LayoutZonePart | null;
  startsLayoutBand: boolean;
}

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

function centerX(box: BoundingBox): number {
  return box.x + box.width / 2;
}

function sharesRow(first: LayoutLine, second: LayoutLine): boolean {
  return (
    Math.abs(centerY(first.box) - centerY(second.box)) <=
    Math.min(first.box.height, second.box.height) / 2
  );
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

function zoneIndexesForLine(
  lineIndex: number,
  zones: LayoutZoneCandidate[]
): number[] {
  return zones
    .map((zone, zoneIndex) => ({ zone, zoneIndex }))
    .filter(({ zone }) => zone.participatingLineIndexes.includes(lineIndex))
    .map(({ zoneIndex }) => zoneIndex);
}

function parallelLaneForLine(
  lineIndex: number,
  lines: LayoutLine[],
  zones: LayoutZoneCandidate[]
): { zoneIndex: number; part: LayoutZonePart } | null {
  const lineCenter = centerX(lines[lineIndex]!.box);
  return zones
    .map((zone, zoneIndex) => ({ zone, zoneIndex }))
    .filter(({ zone }) =>
      zone.kind === 'parallel-columns' ||
      (
        zone.kind === 'sidebar-main' &&
        zone.reasons.includes('both lanes have independent section candidates')
      )
    )
    .flatMap(({ zone, zoneIndex }) => zone.parts
      .filter((part) =>
        part.lineIndexes.includes(lineIndex) &&
        lineCenter >= part.box.x && lineCenter <= right(part.box)
      )
      .map((part) => ({ zoneIndex, part })))
    .sort((a, b) => {
      const aBoundaryWidth = zones[a.zoneIndex]!.boundaryBox?.width ?? Number.POSITIVE_INFINITY;
      const bBoundaryWidth = zones[b.zoneIndex]!.boundaryBox?.width ?? Number.POSITIVE_INFINITY;
      return aBoundaryWidth - bBoundaryWidth ||
        a.part.box.width * a.part.box.height - b.part.box.width * b.part.box.height;
    })[0] ?? null;
}

function hasFullWidthSupport(
  lineIndex: number,
  zones: LayoutZoneCandidate[]
): boolean {
  return zones.some(
    (zone) =>
      zone.kind === 'full-width-section' &&
      zone.participatingLineIndexes.includes(lineIndex)
  );
}

function sameRowSectionPeers(
  lineIndex: number,
  lines: LayoutLine[],
  candidates: BoundaryCandidate[]
): number[] {
  const line = lines[lineIndex]!;
  return candidates
    .filter(
      (candidate) =>
        candidate.lineIndex !== lineIndex &&
        candidate.section.score >= 0.6 &&
        sharesRow(line, lines[candidate.lineIndex]!)
    )
    .map((candidate) => candidate.lineIndex);
}

function isStrongSameRowSectionGroup(
  candidate: BoundaryCandidate,
  peerIndexes: number[],
  lines: LayoutLine[],
  candidates: BoundaryCandidate[]
): boolean {
  if (peerIndexes.length === 0) {
    return false;
  }
  const groupIndexes = [candidate.lineIndex, ...peerIndexes];
  return groupIndexes.every((lineIndex) => {
    const peerCandidate = candidates.find((item) => item.lineIndex === lineIndex);
    const line = lines[lineIndex];
    const common = peerCandidate?.section.reasons.includes('exact common section heading') ?? false;
    const commonPeerToRight = groupIndexes.some((otherIndex) => {
      const otherCandidate = candidates.find((item) => item.lineIndex === otherIndex);
      return (
        otherIndex !== lineIndex &&
        otherCandidate?.section.reasons.includes('exact common section heading') === true &&
        lines[otherIndex]!.box.x > (line?.box.x ?? Number.POSITIVE_INFINITY)
      );
    });
    return (
      peerCandidate !== undefined &&
      line !== undefined &&
      line.bold &&
      peerCandidate.section.score >= 0.8 &&
      (
        common ||
        commonPeerToRight ||
        peerCandidate.section.score - peerCandidate.entry.score >= 0.25
      )
    );
  });
}

function hasStrongHorizontalSupport(
  line: LayoutLine,
  metrics: PageMetrics,
  candidates: NonTextBoundaryCandidate[]
): boolean {
  const activeBox = metrics.activeContentBox;
  if (!activeBox) {
    return false;
  }
  return candidates.some(
    (candidate) =>
      (candidate.kind === 'horizontal-band' || candidate.kind === 'separator') &&
      candidate.evidence.score >= 0.65 &&
      candidate.box.width / activeBox.width >= 0.6 &&
      Math.abs(candidate.box.y - centerY(line.box)) <=
        Math.max(metrics.usualBodyHeight * 3, metrics.usualVerticalGap * 3)
  );
}

function hasPageWideWhitespaceBefore(
  line: LayoutLine,
  metrics: PageMetrics
): boolean {
  const activeBox = metrics.activeContentBox;
  if (!activeBox) {
    return false;
  }
  const leftEdgeTolerance = Math.max(
    metrics.usualBodyHeight * 2,
    activeBox.width * 0.05
  );
  if (line.box.x > activeBox.x + leftEdgeTolerance) {
    return false;
  }
  const minimumHeight = Math.max(
    metrics.usualBodyHeight * 1.5,
    metrics.usualVerticalGap * 2
  );
  const edgeTolerance = Math.max(1, metrics.usualBodyHeight * 0.25);
  return metrics.horizontalBands.some((band) =>
    band.coverage >= 0.9 &&
    band.size >= minimumHeight &&
    Math.abs(bottom(band.box) - line.box.y) <= edgeTolerance
  );
}

function resolveHeadings(input: SectionScopeInput): ResolvedHeading[] {
  const firstRecognizedSectionY = input.boundaryCandidates
    .filter((candidate) => candidate.section.reasons.includes('exact common section heading'))
    .map((candidate) => input.lines[candidate.lineIndex]!.box.y)
    .sort((a, b) => a - b)[0];
  const resolved = input.boundaryCandidates.flatMap((candidate) => {
    if (candidate.section.score < 0.6) {
      return [];
    }
    const lineIndex = candidate.lineIndex;
    const line = input.lines[lineIndex]!;
    const fullWidth = hasFullWidthSupport(lineIndex, input.layoutZoneCandidates);
    const parallelLane = parallelLaneForLine(
      lineIndex,
      input.lines,
      input.layoutZoneCandidates
    );
    const peers = sameRowSectionPeers(lineIndex, input.lines, input.boundaryCandidates);
    const strongSameRowGroup = isStrongSameRowSectionGroup(
      candidate,
      peers,
      input.lines,
      input.boundaryCandidates
    );
    const horizontalSupport = hasStrongHorizontalSupport(
      line,
      input.metrics,
      input.nonTextBoundaryCandidates
    );
    const startsLayoutBand = peers.length === 0 &&
      (fullWidth || hasPageWideWhitespaceBefore(line, input.metrics));
    // A visually prominent entry anchor often looks like a weak section
    // heading in isolation. Require a useful margin before confirming it as a
    // standalone section; entry resolution later uses repeated structure only
    // inside the section scopes established here.
    const commonSection = candidate.section.reasons.includes('exact common section heading');
    const sameLaneHeading = input.boundaryCandidates.some((other) =>
      other.lineIndex !== lineIndex &&
      other.section.reasons.includes('exact common section heading') &&
      Math.abs(input.lines[other.lineIndex]!.box.x - line.box.x) <= 3 &&
      Math.abs(input.lines[other.lineIndex]!.box.y - line.box.y) <=
        input.metrics.usualBodyHeight * 15
    );
    const distinctHeadingLane = input.boundaryCandidates.find((other) =>
      other.section.reasons.includes('exact common section heading') &&
      Math.abs(input.lines[other.lineIndex]!.box.x - line.box.x) >=
        input.metrics.usualBodyHeight * 4
    );
    const repeatedParallelLane = sameLaneHeading && distinctHeadingLane !== undefined;
    const preSectionPreamble = !commonSection &&
      firstRecognizedSectionY !== undefined &&
      line.box.y < firstRecognizedSectionY;
    const governsContent = input.lines.filter((other) =>
      other !== line &&
      other.box.y > line.box.y &&
      other.box.y - line.box.y <= Math.max(input.metrics.usualBodyHeight * 8, 80) &&
      other.box.x < right(line.box) + input.metrics.usualBodyHeight * 8 &&
      right(other.box) > line.box.x - input.metrics.usualBodyHeight * 8
    ).length >= 2;
    // Entry roles are contextual children of sections. A recognized section
    // label must therefore establish its scope before entry evidence is
    // allowed to compete inside that scope.
    const entryCompetition = !commonSection &&
      candidate.entry.score >= candidate.section.score - 0.2;
    const headerCompetition = candidate.header.score >= candidate.section.score;
    const zoneIndexes = zoneIndexesForLine(lineIndex, input.layoutZoneCandidates);
    const reasons = [`section evidence scored ${candidate.section.score}`];

    if (headerCompetition && !fullWidth) {
      return [];
    }

    let status: SectionScopeStatus = 'provisional';
    let mode: SectionScopeMode = peers.length > 0 ? 'provisional-cell' : 'cross-lane';
    let confidence = candidate.section.score * 0.75;
    let lanePart: LayoutZonePart | null = null;

    if (preSectionPreamble) {
      reasons.push('non-section preamble before the first recognized section');
    } else if (commonSection) {
      status = 'confirmed';
      mode = startsLayoutBand
        ? 'cross-lane'
        : parallelLane || peers.length > 0 || repeatedParallelLane
          ? 'lane-local'
          : 'cross-lane';
      confidence += 0.2;
      lanePart = mode === 'lane-local' ? parallelLane?.part ?? null : null;
      reasons.push('recognized section label establishes scope before entry resolution');
    } else if (fullWidth && governsContent) {
      status = 'confirmed';
      mode = 'cross-lane';
      confidence += 0.2;
      reasons.push('standalone full-width section hypothesis');
    } else if (strongSameRowGroup) {
      status = 'confirmed';
      mode = 'lane-local';
      confidence += 0.15;
      reasons.push('strong same-row section peers confirm independent lane-local sections');
    } else if (
      parallelLane &&
      !entryCompetition &&
      governsContent &&
      candidate.section.score >= 0.8 &&
      candidate.section.score - candidate.entry.score >= 0.3
    ) {
      status = 'confirmed';
      mode = 'lane-local';
      confidence += 0.15;
      lanePart = parallelLane.part;
      reasons.push('independent heading inside a confirmed parallel-lane hypothesis');
    } else if (
      candidate.section.score >= 0.8 &&
      line.bold &&
      !entryCompetition &&
      governsContent &&
      candidate.section.score - candidate.entry.score >= 0.3 &&
      peers.length === 0
    ) {
      status = 'confirmed';
      mode = 'cross-lane';
      confidence += horizontalSupport ? 0.15 : 0.05;
      reasons.push('strong standalone section evidence');
    } else {
      reasons.push(
        entryCompetition
          ? 'entry evidence competes with section evidence'
          : peers.length > 0
            ? 'same-row section peers remain unresolved'
            : 'section evidence remains below confirmation requirements'
      );
    }

    if (horizontalSupport) {
      confidence += 0.05;
      reasons.push('nearby strong horizontal boundary evidence');
    }
    if (startsLayoutBand && status === 'confirmed') {
      confidence += 0.05;
      reasons.push('page-wide whitespace starts a new layout band');
    }
    const verticalZone = input.layoutZoneCandidates.some(
      (zone) =>
        ['sidebar-main', 'parallel-columns'].includes(zone.kind) &&
        zone.participatingLineIndexes.includes(lineIndex)
    );
    if (verticalZone && mode === 'cross-lane') {
      reasons.push('provisional vertical zones do not limit this scope');
    }

    return [{
      candidate,
      status,
      mode,
      confidence: round(clamp(confidence)),
      reasons,
      zoneIndexes,
      lanePart,
      startsLayoutBand: startsLayoutBand && status === 'confirmed'
    }];
  });
  return resolved;
}

function provisionalCellBounds(
  heading: ResolvedHeading,
  headings: ResolvedHeading[],
  input: SectionScopeInput
): { left: number; right: number } {
  const line = input.lines[heading.candidate.lineIndex]!;
  const laneRepresentatives = headings
    .map((candidate) => input.lines[candidate.candidate.lineIndex]!)
    .sort((a, b) => a.box.x - b.box.x)
    .filter(
      (candidate, index, all) =>
        index === 0 || Math.abs(candidate.box.x - all[index - 1]!.box.x) > 3
    );
  const index = laneRepresentatives.findIndex(
    (candidate) => Math.abs(candidate.box.x - line.box.x) <= 3
  );
  const previous = laneRepresentatives[index - 1];
  const next = laneRepresentatives[index + 1];
  const dividerBetween = (leftLine: LayoutLine, rightLine: LayoutLine): number => {
    const gutter = input.metrics.verticalGutters
      .filter(
        (candidate) =>
          candidate.box.x >= right(leftLine.box) - 3 &&
          right(candidate.box) <= rightLine.box.x + 3
      )
      .sort((a, b) => b.box.width - a.box.width)[0];
    return gutter
      ? centerX(gutter.box)
      : (right(leftLine.box) + rightLine.box.x) / 2;
  };
  return {
    left: previous
      ? dividerBetween(previous, line)
      : input.metrics.activeContentBox!.x,
    right: next
      ? dividerBetween(line, next)
      : right(input.metrics.activeContentBox!)
  };
}

function headingArea(
  heading: ResolvedHeading,
  headings: ResolvedHeading[],
  input: SectionScopeInput
): { left: number; right: number } {
  const activeBox = input.metrics.activeContentBox!;
  if (heading.mode === 'lane-local') {
    return heading.lanePart
      ? { left: heading.lanePart.box.x, right: right(heading.lanePart.box) }
      : provisionalCellBounds(heading, headings, input);
  }
  if (heading.mode === 'provisional-cell') {
    return provisionalCellBounds(heading, headings, input);
  }
  return { left: activeBox.x, right: right(activeBox) };
}

function compatibleNextHeading(
  heading: ResolvedHeading,
  headings: ResolvedHeading[],
  input: SectionScopeInput,
  area: { left: number; right: number }
): ResolvedHeading | null {
  const line = input.lines[heading.candidate.lineIndex]!;
  return headings
    .filter((candidate) => {
      if (
        candidate === heading ||
        (heading.status === 'confirmed' && candidate.status !== 'confirmed')
      ) {
        return false;
      }
      const candidateLine = input.lines[candidate.candidate.lineIndex]!;
      if (candidateLine.box.y <= line.box.y || sharesRow(line, candidateLine)) {
        return false;
      }
      return candidateLine.box.x < area.right && right(candidateLine.box) > area.left;
    })
    .sort(
      (a, b) =>
        input.lines[a.candidate.lineIndex]!.box.y -
        input.lines[b.candidate.lineIndex]!.box.y
    )[0] ?? null;
}

function nextLayoutBandHeading(
  heading: ResolvedHeading,
  headings: ResolvedHeading[],
  input: SectionScopeInput
): ResolvedHeading | null {
  const line = input.lines[heading.candidate.lineIndex]!;
  return headings
    .filter((candidate) => {
      if (candidate === heading || !candidate.startsLayoutBand) {
        return false;
      }
      const candidateLine = input.lines[candidate.candidate.lineIndex]!;
      return candidateLine.box.y > line.box.y && !sharesRow(line, candidateLine);
    })
    .sort(
      (a, b) =>
        input.lines[a.candidate.lineIndex]!.box.y -
        input.lines[b.candidate.lineIndex]!.box.y
    )[0] ?? null;
}

export function establishSectionScopes(input: SectionScopeInput): SectionScope[] {
  if (input.lines.length === 0 || !input.metrics.activeContentBox) {
    return [];
  }
  const headings = resolveHeadings(input);
  const scopes = headings.map((heading) => {
    const headingLine = input.lines[heading.candidate.lineIndex]!;
    const area = headingArea(heading, headings, input);
    const next = compatibleNextHeading(heading, headings, input, area);
    const nextLayoutBand = nextLayoutBandHeading(heading, headings, input);
    const nextHeadingY = next
      ? input.lines[next.candidate.lineIndex]!.box.y
      : Number.POSITIVE_INFINITY;
    const nextLayoutBandY = nextLayoutBand
      ? input.lines[nextLayoutBand.candidate.lineIndex]!.box.y
      : Number.POSITIVE_INFINITY;
    const endY = Math.min(nextHeadingY, nextLayoutBandY);
    const cellBounded = heading.mode === 'provisional-cell' ||
      (heading.mode === 'lane-local' && heading.lanePart === null);
    const lineIndexes = input.lines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) =>
          (line.box.y >= headingLine.box.y || sharesRow(headingLine, line)) &&
          line.box.y < endY &&
          (cellBounded
            ? centerX(line.box) >= area.left && centerX(line.box) < area.right
            : line.box.x < area.right && right(line.box) > area.left)
      )
      .map(({ index }) => index);
    const reasons = [...heading.reasons];
    if (nextLayoutBand && nextLayoutBandY <= nextHeadingY) {
      reasons.push('next page-wide layout band ends this scope');
    }
    return {
      headingLineIndex: heading.candidate.lineIndex,
      lineIndexes,
      box: unionBox(input.lines, lineIndexes),
      status: heading.status,
      mode: heading.mode,
      confidence: heading.confidence,
      reasons,
      governingZoneCandidateIndexes: heading.zoneIndexes
    };
  });

  // Confirmed ownership is an output invariant, not a best-effort property of
  // independently expanded rectangles. Resolve every conflict globally and
  // retain provisional overlap only as diagnostic evidence.
  const confirmed = scopes.filter((scope) => scope.status === 'confirmed');
  for (let lineIndex = 0; lineIndex < input.lines.length; lineIndex++) {
    const owners = confirmed.filter((scope) => scope.lineIndexes.includes(lineIndex));
    if (owners.length <= 1) {
      continue;
    }
    const line = input.lines[lineIndex]!;
    const winner = owners
      .map((scope) => ({
        scope,
        ownsHeading: scope.headingLineIndex === lineIndex,
        verticalDistance: Math.max(
          0,
          line.box.y - input.lines[scope.headingLineIndex]!.box.y
        )
      }))
      .sort((a, b) =>
        Number(b.ownsHeading) - Number(a.ownsHeading) ||
        a.verticalDistance - b.verticalDistance ||
        b.scope.confidence - a.scope.confidence ||
        a.scope.headingLineIndex - b.scope.headingLineIndex
      )[0]!.scope;
    for (const owner of owners) {
      if (owner !== winner && owner.headingLineIndex !== lineIndex) {
        owner.lineIndexes = owner.lineIndexes.filter((index) => index !== lineIndex);
        owner.reasons.push(
          `line ${lineIndex + 1} assigned to stronger compatible section scope`
        );
      }
    }
  }
  for (const scope of confirmed) {
    scope.box = unionBox(input.lines, scope.lineIndexes);
  }
  return scopes;
}
