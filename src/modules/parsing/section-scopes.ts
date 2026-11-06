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
    .filter(({ zone }) => zone.kind === 'parallel-columns')
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
    return (
      peerCandidate !== undefined &&
      line !== undefined &&
      line.bold &&
      peerCandidate.section.score >= 0.8 &&
      peerCandidate.section.score - peerCandidate.entry.score >= 0.15
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

function resolveHeadings(input: SectionScopeInput): ResolvedHeading[] {
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
    // A visually prominent entry anchor often looks like a weak section
    // heading in isolation. Require a useful margin before confirming it as a
    // standalone section; Stage 7 can resolve the remaining competition from
    // repeated entry structure.
    const entryCompetition = candidate.entry.score >= candidate.section.score - 0.15;
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

    if (fullWidth) {
      status = 'confirmed';
      mode = 'cross-lane';
      confidence += 0.2;
      reasons.push('standalone full-width section hypothesis');
    } else if (strongSameRowGroup) {
      status = 'confirmed';
      mode = 'lane-local';
      confidence += 0.15;
      reasons.push('strong same-row section peers confirm independent lane-local sections');
    } else if (parallelLane && (!entryCompetition || peers.length > 0)) {
      status = 'confirmed';
      mode = 'lane-local';
      confidence += 0.15;
      lanePart = parallelLane.part;
      reasons.push('independent heading inside a confirmed parallel-lane hypothesis');
    } else if (
      candidate.section.score >= 0.8 &&
      line.bold &&
      !entryCompetition &&
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
    const verticalZone = input.layoutZoneCandidates.some(
      (zone) =>
        ['unresolved-gutter', 'sidebar-main', 'parallel-columns'].includes(zone.kind) &&
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
      lanePart
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
  const peers = headings
    .filter(
      (candidate) =>
        candidate !== heading &&
        sharesRow(line, input.lines[candidate.candidate.lineIndex]!)
    )
    .map((candidate) => input.lines[candidate.candidate.lineIndex]!)
    .sort((a, b) => a.box.x - b.box.x);
  const all = [line, ...peers].sort((a, b) => a.box.x - b.box.x);
  const index = all.indexOf(line);
  const previous = all[index - 1];
  const next = all[index + 1];
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

export function establishSectionScopes(input: SectionScopeInput): SectionScope[] {
  if (input.lines.length === 0 || !input.metrics.activeContentBox) {
    return [];
  }
  const headings = resolveHeadings(input);
  const scopes = headings.map((heading) => {
    const headingLine = input.lines[heading.candidate.lineIndex]!;
    const area = headingArea(heading, headings, input);
    const next = compatibleNextHeading(heading, headings, input, area);
    const endY = next
      ? input.lines[next.candidate.lineIndex]!.box.y
      : Number.POSITIVE_INFINITY;
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
    return {
      headingLineIndex: heading.candidate.lineIndex,
      lineIndexes,
      box: unionBox(input.lines, lineIndexes),
      status: heading.status,
      mode: heading.mode,
      confidence: heading.confidence,
      reasons: heading.reasons,
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
