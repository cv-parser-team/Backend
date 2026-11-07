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

function hasParallelHeadingPeer(
  candidate: BoundaryCandidate,
  input: SectionScopeInput,
  includeEstablishedLanes = true
): boolean {
  const line = input.lines[candidate.lineIndex]!;
  const activeWidth = input.metrics.activeContentBox?.width ?? line.box.width;
  const minimumHorizontalDistance = Math.max(
    input.metrics.usualBodyHeight * 4,
    activeWidth * 0.15
  );
  const maximumVerticalDistance = Math.max(
    input.metrics.usualBodyHeight * 8,
    input.metrics.usualVerticalGap * 3
  );
  const recognizedHeadings = input.boundaryCandidates.filter((other) =>
    other.section.reasons.includes('exact common section heading')
  );
  const nearbyParallelPeer = recognizedHeadings.some((other) => {
    if (other.lineIndex === candidate.lineIndex || other.section.score < 0.8) {
      return false;
    }
    const otherLine = input.lines[other.lineIndex]!;
    return (
      otherLine.bold &&
      Math.abs(otherLine.box.x - line.box.x) >= minimumHorizontalDistance &&
      Math.abs(otherLine.box.y - line.box.y) <= maximumVerticalDistance
    );
  });
  const repeatsEstablishedLane = recognizedHeadings.some((other) =>
    other.lineIndex !== candidate.lineIndex &&
    Math.abs(input.lines[other.lineIndex]!.box.x - line.box.x) <=
      input.metrics.usualBodyHeight * 0.5
  );
  const hasDistinctLane = recognizedHeadings.some((other) =>
    Math.abs(input.lines[other.lineIndex]!.box.x - line.box.x) >= minimumHorizontalDistance
  );
  return nearbyParallelPeer ||
    (includeEstablishedLanes && repeatsEstablishedLane && hasDistinctLane);
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

function persistentLaneBoundary(
  candidate: BoundaryCandidate,
  input: SectionScopeInput
): { left: number; right: number } | undefined {
  const gutter = input.metrics.verticalGutters
    .filter((candidate) => candidate.coverage >= 0.6)
    .sort(
      (first, second) =>
        second.coverage - first.coverage ||
        second.box.width - first.box.width
    )[0];
  if (gutter) {
    return { left: gutter.box.x, right: right(gutter.box) };
  }
  const heading = input.lines[candidate.lineIndex]!;
  const distinctHeadingXs = input.boundaryCandidates
    .filter((other) =>
      other.section.reasons.includes('exact common section heading')
    )
    .map((other) => input.lines[other.lineIndex]!.box.x)
    .sort((first, second) => first - second)
    .filter(
      (value, index, values) =>
        index === 0 || value - values[index - 1]! > input.metrics.usualBodyHeight
    );
  const otherLaneX = distinctHeadingXs
    .filter((value) =>
      Math.abs(value - heading.box.x) >= input.metrics.usualBodyHeight * 4
    )
    .sort(
      (first, second) =>
        Math.abs(first - heading.box.x) - Math.abs(second - heading.box.x)
    )[0];
  if (otherLaneX === undefined) {
    return undefined;
  }
  const divider = (heading.box.x + otherLaneX) / 2;
  return { left: divider, right: divider };
}

function laneSide(
  line: LayoutLine,
  boundary: { left: number; right: number }
): 'left' | 'right' | null {
  if (centerX(line.box) < boundary.left) {
    return 'left';
  }
  if (centerX(line.box) > boundary.right) {
    return 'right';
  }
  return null;
}

function hasOppositeLaneContinuation(
  candidate: BoundaryCandidate,
  input: SectionScopeInput
): boolean {
  const heading = input.lines[candidate.lineIndex]!;
  const recognizedHeadings = input.boundaryCandidates.filter((other) =>
    other.section.reasons.includes('exact common section heading')
  );
  const activeOppositeHeading = recognizedHeadings
    .filter((other) => {
      const otherLine = input.lines[other.lineIndex]!;
      return (
        otherLine.box.y < heading.box.y &&
        Math.abs(otherLine.box.x - heading.box.x) >= input.metrics.usualBodyHeight * 4
      );
    })
    .sort(
      (first, second) =>
        input.lines[second.lineIndex]!.box.y - input.lines[first.lineIndex]!.box.y
    )[0];
  if (!activeOppositeHeading) {
    return false;
  }
  const activeHeadingLine = input.lines[activeOppositeHeading.lineIndex]!;
  const divider = (heading.box.x + activeHeadingLine.box.x) / 2;
  const boundary = { left: divider, right: divider };
  const headingSide = laneSide(heading, boundary);
  if (!headingSide) {
    return false;
  }
  const oppositeSide = headingSide === 'left' ? 'right' : 'left';
  const nextOppositeHeadingY = recognizedHeadings
    .filter((other) => {
      const otherLine = input.lines[other.lineIndex]!;
      return (
        other.lineIndex !== activeOppositeHeading.lineIndex &&
        otherLine.box.y > activeHeadingLine.box.y &&
        laneSide(otherLine, boundary) === oppositeSide
      );
    })
    .map((other) => input.lines[other.lineIndex]!.box.y)
    .sort((first, second) => first - second)[0] ?? Number.POSITIVE_INFINITY;
  const maximumDistance = Math.max(
    input.metrics.usualBodyHeight * 8,
    input.metrics.usualVerticalGap * 3,
    80
  );
  const recognizedHeadingIndexes = new Set(
    recognizedHeadings.map((other) => other.lineIndex)
  );
  const firstHeadingSideContentY = input.lines
    .filter(
      (line, lineIndex) =>
        !recognizedHeadingIndexes.has(lineIndex) &&
        line.box.y >= heading.box.y &&
        line.box.y - heading.box.y <= maximumDistance &&
        laneSide(line, boundary) === headingSide
    )
    .map((line) => line.box.y)
    .sort((first, second) => first - second)[0] ?? Number.POSITIVE_INFINITY;
  return input.lines.some(
    (line, lineIndex) =>
      !recognizedHeadingIndexes.has(lineIndex) &&
      line.box.y >= heading.box.y &&
      line.box.y < nextOppositeHeadingY &&
      line.box.y < firstHeadingSideContentY &&
      line.box.y - heading.box.y <= maximumDistance &&
      laneSide(line, boundary) === oppositeSide
  );
}

function hasDirectCrossLaneEvidence(
  candidate: BoundaryCandidate,
  input: SectionScopeInput
): boolean {
  const boundary = persistentLaneBoundary(candidate, input);
  if (!boundary) {
    return false;
  }
  const heading = input.lines[candidate.lineIndex]!;
  const crossesGutter = (line: LayoutLine) =>
    line.box.x <= boundary.left && right(line.box) >= boundary.right;
  if (crossesGutter(heading)) {
    return true;
  }
  const maximumDistance = Math.max(
    input.metrics.usualBodyHeight * 8,
    input.metrics.usualVerticalGap * 3,
    80
  );
  const nextRecognizedHeadingY = input.boundaryCandidates
    .filter(
      (other) =>
        other.lineIndex !== candidate.lineIndex &&
        other.section.reasons.includes('exact common section heading') &&
        input.lines[other.lineIndex]!.box.y > heading.box.y
    )
    .map((other) => input.lines[other.lineIndex]!.box.y)
    .sort((first, second) => first - second)[0] ?? Number.POSITIVE_INFINITY;
  const recognizedHeadingIndexes = new Set(
    input.boundaryCandidates
      .filter((other) =>
        other.section.reasons.includes('exact common section heading')
      )
      .map((other) => other.lineIndex)
  );
  const followingLines = input.lines.filter(
    (line, lineIndex) =>
      !recognizedHeadingIndexes.has(lineIndex) &&
      line.box.y > heading.box.y &&
      line.box.y < nextRecognizedHeadingY &&
      line.box.y - heading.box.y <= maximumDistance
  );
  if (followingLines.some(crossesGutter)) {
    return true;
  }
  const crossLaneRows = followingLines.filter((line, lineIndex, lines) => {
    if (lines.findIndex((other) => sharesRow(line, other)) !== lineIndex) {
      return false;
    }
    const row = lines.filter((other) => sharesRow(line, other));
    const leftCount = row.filter((other) => centerX(other.box) < boundary.left).length;
    const rightCount = row.filter(
      (other) => centerX(other.box) > boundary.right
    ).length;
    return leftCount > 0 && rightCount > 0;
  });
  if (crossLaneRows.length >= 2) {
    return true;
  }
  return followingLines.some((line) => {
    const row = followingLines.filter((other) => sharesRow(line, other));
    const leftCount = row.filter((other) => centerX(other.box) < boundary.left).length;
    const rightCount = row.filter(
      (other) => centerX(other.box) > boundary.right
    ).length;
    return leftCount > 0 && rightCount > 0 && row.length >= 3;
  });
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
    const parallelHeadingPeer = hasParallelHeadingPeer(candidate, input);
    const nearbyParallelHeadingPeer = hasParallelHeadingPeer(candidate, input, false);
    const layoutBandEvidence =
      horizontalSupport || hasPageWideWhitespaceBefore(line, input.metrics);
    const directCrossLaneEvidence = hasDirectCrossLaneEvidence(candidate, input);
    const oppositeLaneContinuation = hasOppositeLaneContinuation(candidate, input);
    const startsLayoutBand = peers.length === 0 &&
      !nearbyParallelHeadingPeer &&
      layoutBandEvidence &&
      !oppositeLaneContinuation &&
      (!parallelHeadingPeer || directCrossLaneEvidence);
    // A visually prominent entry anchor often looks like a weak section
    // heading in isolation. Require a useful margin before confirming it as a
    // standalone section; entry resolution later uses repeated structure only
    // inside the section scopes established here.
    const commonSection = candidate.section.reasons.includes('exact common section heading');
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
    const documentTitle = !commonSection &&
      candidate.header.score >= 0.8 &&
      candidate.header.score >= candidate.section.score;
    const zoneIndexes = zoneIndexesForLine(lineIndex, input.layoutZoneCandidates);
    const reasons = [`section evidence scored ${candidate.section.score}`];

    if (documentTitle) {
      return [];
    }

    let status: SectionScopeStatus = 'provisional';
    let mode: SectionScopeMode = peers.length > 0 ? 'provisional-cell' : 'cross-lane';
    let confidence = candidate.section.score * 0.75;

    if (preSectionPreamble) {
      reasons.push('non-section preamble before the first recognized section');
    } else if (commonSection) {
      status = 'confirmed';
      mode = startsLayoutBand
        ? 'cross-lane'
        : parallelHeadingPeer || peers.length > 0 || oppositeLaneContinuation
          ? 'lane-local'
          : 'cross-lane';
      confidence += 0.2;
      reasons.push('recognized section label establishes scope before entry resolution');
    } else if (strongSameRowGroup) {
      status = 'confirmed';
      mode = 'lane-local';
      confidence += 0.15;
      reasons.push('strong same-row section peers confirm independent lane-local sections');
    } else if (
      horizontalSupport &&
      governsContent &&
      !parallelHeadingPeer &&
      !entryCompetition &&
      candidate.section.score >= 0.8 &&
      candidate.section.score - candidate.entry.score >= 0.3
    ) {
      status = 'confirmed';
      mode = 'cross-lane';
      confidence += 0.2;
      reasons.push('strong horizontal boundary establishes a section band');
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
    } else if (
      layoutBandEvidence &&
      (parallelHeadingPeer || oppositeLaneContinuation) &&
      status === 'confirmed' &&
      mode === 'lane-local'
    ) {
      reasons.push(
        oppositeLaneContinuation
          ? 'active section continues in the opposite lane'
          : 'persistent lane alignment keeps this section lane-local'
      );
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
      startsLayoutBand: startsLayoutBand && status === 'confirmed'
    }];
  });
  return resolved;
}

function laneBounds(
  heading: ResolvedHeading,
  headings: ResolvedHeading[],
  input: SectionScopeInput
): { left: number; right: number } {
  const line = input.lines[heading.candidate.lineIndex]!;
  const laneRepresentatives = headings
    .filter((candidate) =>
      (candidate.status === 'confirmed' && candidate.mode === 'lane-local') ||
      (heading.status === 'provisional' && candidate.mode === 'provisional-cell')
    )
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

interface HorizontalBounds {
  left: number;
  right: number;
  reasons: string[];
}

function structuralLanePart(
  heading: ResolvedHeading,
  input: SectionScopeInput
): LayoutZonePart | null {
  const headingLine = input.lines[heading.candidate.lineIndex]!;
  return input.layoutZoneCandidates
    .filter(
      (zone) =>
        (zone.kind === 'parallel-columns' || zone.kind === 'sidebar-main') &&
        zone.confidence >= 0.65 &&
        zone.participatingLineIndexes.includes(heading.candidate.lineIndex)
    )
    .map((zone) => ({
      zone,
      part: zone.parts.find(
        (candidate) =>
          candidate.lineIndexes.includes(heading.candidate.lineIndex) &&
          centerX(headingLine.box) >= candidate.box.x &&
          centerX(headingLine.box) < right(candidate.box)
      )
    }))
    .filter(
      (candidate): candidate is { zone: LayoutZoneCandidate; part: LayoutZonePart } =>
        candidate.part !== undefined
    )
    .sort(
      (first, second) =>
        second.zone.confidence - first.zone.confidence ||
        first.part.box.width - second.part.box.width
    )[0]?.part ?? null;
}

function projectedSectionBottom(
  heading: ResolvedHeading,
  headings: ResolvedHeading[],
  lane: LayoutZonePart,
  input: SectionScopeInput
): number {
  const headingLine = input.lines[heading.candidate.lineIndex]!;
  return headings
    .filter((candidate) => candidate !== heading && candidate.status === 'confirmed')
    .map((candidate) => input.lines[candidate.candidate.lineIndex]!)
    .filter(
      (candidate) =>
        candidate.box.y > headingLine.box.y &&
        centerX(candidate.box) >= lane.box.x &&
        centerX(candidate.box) < right(lane.box)
    )
    .sort((first, second) => first.box.y - second.box.y)[0]?.box.y ??
    bottom(input.metrics.activeContentBox!);
}

function refineStructuralLane(
  heading: ResolvedHeading,
  headings: ResolvedHeading[],
  lane: LayoutZonePart,
  input: SectionScopeInput
): HorizontalBounds {
  const headingLine = input.lines[heading.candidate.lineIndex]!;
  const projectedBottom = projectedSectionBottom(heading, headings, lane, input);
  const projectedHeight = Math.max(projectedBottom - headingLine.box.y, 1);
  const edgeTolerance = Math.max(
    input.metrics.usualBodyHeight * 2,
    lane.box.width * 0.08
  );
  const separators = input.nonTextBoundaryCandidates
    .filter((candidate) => {
      if (
        candidate.kind !== 'separator' ||
        candidate.box.height <= candidate.box.width ||
        candidate.evidence.score < 0.55
      ) {
        return false;
      }
      const overlap = Math.max(
        0,
        Math.min(projectedBottom, bottom(candidate.box)) -
          Math.max(headingLine.box.y, candidate.box.y)
      );
      const nearLeft = Math.abs(centerX(candidate.box) - lane.box.x) <= edgeTolerance;
      const nearRight = Math.abs(centerX(candidate.box) - right(lane.box)) <= edgeTolerance;
      return overlap / projectedHeight >= 0.5 && (nearLeft || nearRight);
    })
    .sort((first, second) =>
      Math.min(
        Math.abs(centerX(first.box) - lane.box.x),
        Math.abs(centerX(first.box) - right(lane.box))
      ) -
      Math.min(
        Math.abs(centerX(second.box) - lane.box.x),
        Math.abs(centerX(second.box) - right(lane.box))
      ) || second.evidence.score - first.evidence.score
    );
  const separator = separators[0];
  if (!separator) {
    return {
      left: lane.box.x,
      right: right(lane.box),
      reasons: ['persistent macro-layout lane sets horizontal ownership']
    };
  }
  const refinesLeft =
    Math.abs(centerX(separator.box) - lane.box.x) <=
    Math.abs(centerX(separator.box) - right(lane.box));
  return {
    left: refinesLeft ? right(separator.box) : lane.box.x,
    right: refinesLeft ? right(lane.box) : separator.box.x,
    reasons: [
      'persistent macro-layout lane sets horizontal ownership',
      'corroborating vertical separator refines the lane edge'
    ]
  };
}

function headingArea(
  heading: ResolvedHeading,
  headings: ResolvedHeading[],
  input: SectionScopeInput
): HorizontalBounds {
  const activeBox = input.metrics.activeContentBox!;
  if (heading.mode === 'lane-local') {
    const lane = structuralLanePart(heading, input);
    if (lane) {
      return refineStructuralLane(heading, headings, lane, input);
    }
    return {
      ...laneBounds(heading, headings, input),
      reasons: ['neighboring section headings set fallback horizontal ownership']
    };
  }
  if (heading.mode === 'provisional-cell') {
    return {
      ...laneBounds(heading, headings, input),
      reasons: ['neighboring section headings set provisional cell ownership']
    };
  }
  return {
    left: activeBox.x,
    right: right(activeBox),
    reasons: ['active-content page edges set cross-lane ownership']
  };
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
    const cellBounded = heading.mode !== 'cross-lane';
    const governedLineIndexes = input.lines
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
    const lineIndexes = [...new Set([
      heading.candidate.lineIndex,
      ...governedLineIndexes
    ])].sort((first, second) => first - second);
    const reasons = [...heading.reasons, ...area.reasons];
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
