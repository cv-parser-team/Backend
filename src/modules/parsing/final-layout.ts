import type { EntryGroup } from './entry-groups.js';
import { isCommonSectionHeading } from './boundary-candidates.js';
import type { LayoutLine } from './layout.js';
import type { LayoutZoneCandidate } from './macro-layout.js';
import type { SectionScope } from './section-scopes.js';
import type { BoundingBox } from './parsing.types.js';
import { normalizeSemanticText } from './semantic-text.js';

export type FinalRegionRole = 'independent' | 'section' | 'entry' | 'content';

export interface ValidatedLayoutZone {
  candidateIndex: number;
  accepted: boolean;
  confidence: number;
  reasons: string[];
}

export interface SectionColumn {
  sectionHeadingLineIndex: number;
  lineIndexes: number[];
  box: BoundingBox;
  confidence: number;
  source: 'layout-zone' | 'section-local';
}

export interface FinalRegionDraft {
  index: number;
  role: FinalRegionRole;
  parentIndex: number | null;
  sectionHeadingLineIndex: number | null;
  confidence: number;
  box: BoundingBox;
  lineIndexes: number[];
  readingOrderLineIndexes: number[];
}

export interface FinalLayoutResolution {
  validatedZones: ValidatedLayoutZone[];
  sectionColumns: SectionColumn[];
  regions: FinalRegionDraft[];
  aiInputLines: string[];
}

interface FinalLayoutInput {
  pageNumber: number;
  lines: LayoutLine[];
  layoutZoneCandidates: LayoutZoneCandidate[];
  sectionScopes: SectionScope[];
  entryGroups: EntryGroup[];
  lineReferences?: number[];
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

function crossesVerticalBoundary(indexes: number[], boundary: BoundingBox, lines: LayoutLine[]): boolean {
  const leftSide = indexes.some((index) => right(lines[index]!.box) <= boundary.x + 3);
  const rightSide = indexes.some((index) => lines[index]!.box.x >= right(boundary) - 3);
  return leftSide && rightSide;
}

function validateZones(input: FinalLayoutInput): ValidatedLayoutZone[] {
  return input.layoutZoneCandidates.flatMap<ValidatedLayoutZone>((zone, candidateIndex) => {
    const reasons = [...zone.reasons];
    if (!zone.boundaryBox || zone.boundaryBox.width >= zone.boundaryBox.height) {
      return [];
    }
    const cutGroup = input.entryGroups.find((group) =>
      crossesVerticalBoundary(group.lineIndexes, zone.boundaryBox!, input.lines)
    );
    if (cutGroup) {
      return [{
        candidateIndex,
        accepted: false,
        confidence: zone.confidence,
        reasons: [...reasons, `rejected because it divides entry anchored at line ${cutGroup.anchorLineIndex + 1}`]
      }];
    }
    reasons.push('accepted without dividing an entry group');
    return [{ candidateIndex, accepted: true, confidence: zone.confidence, reasons }];
  });
}

function rowAwareOrder(
  indexes: number[],
  lines: LayoutLine[],
  priorityIndexes: ReadonlySet<number> = new Set()
): number[] {
  const sorted = [...indexes].sort((a, b) => {
    const first = lines[a]!;
    const second = lines[b]!;
    const firstCenter = first.box.y + first.box.height / 2;
    const secondCenter = second.box.y + second.box.height / 2;
    return firstCenter - secondCenter || first.box.x - second.box.x || a - b;
  });
  const rows: number[][] = [];
  for (const index of sorted) {
    const row = rows.at(-1);
    if (!row) {
      rows.push([index]);
      continue;
    }
    const anchor = lines[row[0]!]!;
    const line = lines[index]!;
    const centerDistance = Math.abs(
      anchor.box.y + anchor.box.height / 2 - (line.box.y + line.box.height / 2)
    );
    if (centerDistance <= Math.min(anchor.box.height, line.box.height) / 2) {
      row.push(index);
    } else {
      rows.push([index]);
    }
  }
  return rows.flatMap((row) => row.sort((a, b) =>
    Number(priorityIndexes.has(b)) - Number(priorityIndexes.has(a)) ||
    lines[a]!.box.x - lines[b]!.box.x || a - b
  ));
}

function entryReadingOrder(group: EntryGroup, lines: LayoutLine[]): number[] {
  const rest = group.lineIndexes.filter((index) => index !== group.anchorLineIndex);
  const metadata = columnFirstOrder(
    rest.filter((index) => isMetadata(lines[index]!.text)),
    lines,
    group.box
  );
  const body = columnFirstOrder(
    rest.filter((index) => !isMetadata(lines[index]!.text)),
    lines,
    group.box
  );
  return [group.anchorLineIndex, ...metadata, ...body];
}

function splitHeadingContinuations(
  scope: SectionScope,
  indexes: number[],
  lines: LayoutLine[]
): number[] {
  const heading = lines[scope.headingLineIndex]!;
  return indexes
    .filter((index) => {
      if (index === scope.headingLineIndex) {
        return false;
      }
      const line = lines[index]!;
      const gap = line.box.y - bottom(heading.box);
      return (
        line.bold === heading.bold &&
        line.italic === heading.italic &&
        Math.abs(line.box.x - heading.box.x) <= 3 &&
        Math.abs(line.box.height - heading.box.height) <= 1 &&
        gap >= -heading.box.height / 4 &&
        gap <= heading.box.height * 0.75 &&
        isCommonSectionHeading(`${heading.text} ${line.text}`)
      );
    })
    .sort((a, b) => lines[a]!.box.y - lines[b]!.box.y);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function verticalOverlap(indexes: number[], lines: LayoutLine[]): { top: number; bottom: number } {
  return {
    top: Math.min(...indexes.map((index) => lines[index]!.box.y)),
    bottom: Math.max(...indexes.map((index) => bottom(lines[index]!.box)))
  };
}

function centerY(box: BoundingBox): number {
  return box.y + box.height / 2;
}

function horizontalOverlap(first: BoundingBox, second: BoundingBox): number {
  return Math.max(0, Math.min(right(first), right(second)) - Math.max(first.x, second.x));
}

function sharesRow(first: LayoutLine, second: LayoutLine): boolean {
  return Math.abs(centerY(first.box) - centerY(second.box)) <=
    Math.min(first.box.height, second.box.height) / 2;
}

function flowComponents(
  indexes: number[],
  lines: LayoutLine[],
  connectAlignedMetadata = false
): number[][] {
  if (indexes.length < 2) {
    return indexes.length === 0 ? [] : [indexes];
  }
  const usualHeight = median(indexes.map((index) => lines[index]!.box.height));
  const parents = indexes.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]!]!;
      current = parents[current]!;
    }
    return current;
  };
  const join = (first: number, second: number): void => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) {
      parents[secondRoot] = firstRoot;
    }
  };
  for (let firstPosition = 0; firstPosition < indexes.length; firstPosition += 1) {
    const first = lines[indexes[firstPosition]!]!;
    for (let secondPosition = firstPosition + 1; secondPosition < indexes.length; secondPosition += 1) {
      const second = lines[indexes[secondPosition]!]!;
      if (sharesRow(first, second)) {
        const horizontalGap = Math.max(
          0,
          Math.max(first.box.x, second.box.x) - Math.min(right(first.box), right(second.box))
        );
        const metadataPair = isMetadata(first.text) !== isMetadata(second.text);
        if (
          horizontalGap <= usualHeight * 1.25 ||
          (connectAlignedMetadata && metadataPair)
        ) {
          join(firstPosition, secondPosition);
        }
        continue;
      }
      const upper = first.box.y <= second.box.y ? first : second;
      const lower = upper === first ? second : first;
      const verticalGap = lower.box.y - bottom(upper.box);
      if (verticalGap < -usualHeight / 2 || verticalGap > usualHeight * 2.25) {
        continue;
      }
      const overlap = horizontalOverlap(upper.box, lower.box);
      const aligned = Math.abs(upper.box.x - lower.box.x) <= usualHeight * 1.75;
      const indentedContinuation = lower.box.x >= upper.box.x &&
        lower.box.x - upper.box.x <= usualHeight * 2.5;
      if (
        aligned ||
        overlap >= Math.min(upper.box.width, lower.box.width) * 0.2 ||
        (lower.bullet && indentedContinuation)
      ) {
        join(firstPosition, secondPosition);
      }
    }
  }
  const components = new Map<number, number[]>();
  indexes.forEach((lineIndex, position) => {
    const root = find(position);
    const component = components.get(root) ?? [];
    component.push(lineIndex);
    components.set(root, component);
  });
  return [...components.values()].map((component) => component.sort((a, b) =>
    lines[a]!.box.y - lines[b]!.box.y || lines[a]!.box.x - lines[b]!.box.x || a - b
  ));
}

function localColumnLanes(
  scope: SectionScope,
  indexes: number[],
  lines: LayoutLine[]
): number[][] {
  if (indexes.length < 4) {
    return [indexes];
  }
  const usualHeight = median(indexes.map((index) => lines[index]!.box.height));
  const components = flowComponents(indexes, lines);
  const lanes: number[][] = [];
  for (const component of components.sort((a, b) =>
    unionBox(lines, a).x - unionBox(lines, b).x
  )) {
    const componentBox = unionBox(lines, component);
    const lane = lanes.find((candidate) => {
      const laneBox = unionBox(lines, candidate);
      return horizontalOverlap(componentBox, laneBox) > 0 ||
        Math.abs(componentBox.x - laneBox.x) <= usualHeight * 1.5;
    });
    if (lane) {
      lane.push(...component);
    } else {
      lanes.push([...component]);
    }
  }
  if (lanes.length < 2 || lanes.some((lane) => lane.length < 2)) {
    return [indexes];
  }
  lanes.sort((a, b) => unionBox(lines, a).x - unionBox(lines, b).x);
  const minimumGutter = Math.max(usualHeight * 1.5, scope.box.width * 0.03);
  for (let index = 0; index < lanes.length - 1; index += 1) {
    const leftLane = lanes[index]!;
    const rightLane = lanes[index + 1]!;
    const leftBox = unionBox(lines, leftLane);
    const rightBox = unionBox(lines, rightLane);
    const leftRange = verticalOverlap(leftLane, lines);
    const rightRange = verticalOverlap(rightLane, lines);
    const overlap = Math.min(leftRange.bottom, rightRange.bottom) -
      Math.max(leftRange.top, rightRange.top);
    if (rightBox.x - right(leftBox) < minimumGutter || overlap < usualHeight) {
      return [indexes];
    }
  }
  return lanes.map((lane) => lane.sort((a, b) =>
    lines[a]!.box.y - lines[b]!.box.y || lines[a]!.box.x - lines[b]!.box.x || a - b
  ));
}

function columnFirstOrder(
  indexes: number[],
  lines: LayoutLine[],
  box: BoundingBox
): number[] {
  if (indexes.length < 2) {
    return indexes;
  }
  const lanes = localColumnLanes(
    {
      headingLineIndex: -1,
      kind: 'other',
      lineIndexes: indexes,
      box,
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 1,
      reasons: [],
      governingZoneCandidateIndexes: []
    },
    indexes,
    lines
  );
  return lanes.flatMap((lane) => lane.sort((a, b) =>
    lines[a]!.box.y - lines[b]!.box.y || lines[a]!.box.x - lines[b]!.box.x || a - b
  ));
}

function resolveSectionColumns(
  input: FinalLayoutInput
): SectionColumn[] {
  return input.sectionScopes
    .filter((scope) => scope.status === 'confirmed' && scope.mode === 'cross-lane')
    .flatMap<SectionColumn>((scope) => {
      const groupedIndexes = new Set(
        input.entryGroups
          .filter((group) => group.sectionHeadingLineIndex === scope.headingLineIndex)
          .flatMap((group) => group.lineIndexes)
      );
      const headingContinuations = new Set(
        splitHeadingContinuations(scope, scope.lineIndexes, input.lines)
      );
      const localIndexes = scope.lineIndexes.filter(
        (index) =>
          index !== scope.headingLineIndex &&
          !headingContinuations.has(index) &&
          !groupedIndexes.has(index)
      );
      const localLanes = localColumnLanes(scope, localIndexes, input.lines);
      if (localLanes.length > 1) {
        return localLanes.map((lineIndexes) => ({
          sectionHeadingLineIndex: scope.headingLineIndex,
          lineIndexes,
          box: unionBox(input.lines, lineIndexes),
          confidence: 0.85,
          source: 'section-local' as const
        }));
      }
      return [];
    });
}

function createRegions(
  input: FinalLayoutInput,
  sectionColumns: SectionColumn[]
): FinalRegionDraft[] {
  const confirmedScopes = input.sectionScopes
    .filter((scope) => scope.status === 'confirmed')
    .sort((a, b) =>
      input.lines[a.headingLineIndex]!.box.y - input.lines[b.headingLineIndex]!.box.y ||
      input.lines[a.headingLineIndex]!.box.x - input.lines[b.headingLineIndex]!.box.x
    );
  const claimed = new Set<number>();
  type RegionDraft = Omit<FinalRegionDraft, 'index' | 'parentIndex'>;
  interface DraftGroup {
    box: BoundingBox;
    header: boolean;
    drafts: RegionDraft[];
  }
  const draftGroups: DraftGroup[] = [];
  const headingIndexes = new Set(confirmedScopes.map((scope) => scope.headingLineIndex));

  for (const scope of confirmedScopes) {
    const drafts: RegionDraft[] = [];
    const groups = input.entryGroups.filter(
      (group) => group.sectionHeadingLineIndex === scope.headingLineIndex
    );
    const grouped = new Set(groups.flatMap((group) => group.lineIndexes));
    const columns = sectionColumns
      .filter((column) => column.sectionHeadingLineIndex === scope.headingLineIndex)
      .map((column) => ({
        ...column,
        lineIndexes: column.lineIndexes.filter((index) => !grouped.has(index))
      }))
      .filter((column) => column.lineIndexes.length > 0);
    const columnLines = new Set(columns.flatMap((column) => column.lineIndexes));
    const direct = scope.lineIndexes.filter(
      (index) => !grouped.has(index) && !columnLines.has(index)
    );
    if (direct.length > 0) {
      const headingContinuations = splitHeadingContinuations(scope, direct, input.lines);
      const headingContinuationSet = new Set(headingContinuations);
      drafts.push({
        role: 'section',
        sectionHeadingLineIndex: scope.headingLineIndex,
        confidence: scope.confidence,
        box: unionBox(input.lines, direct),
        lineIndexes: direct,
        readingOrderLineIndexes: [
          scope.headingLineIndex,
          ...headingContinuations,
          ...columnFirstOrder(
            direct.filter(
              (index) =>
                index !== scope.headingLineIndex && !headingContinuationSet.has(index)
            ),
            input.lines,
            scope.box
          )
        ]
      });
      direct.forEach((index) => claimed.add(index));
    }
    for (const column of columns) {
      drafts.push({
        role: 'content',
        sectionHeadingLineIndex: scope.headingLineIndex,
        confidence: column.confidence,
        box: unionBox(input.lines, column.lineIndexes),
        lineIndexes: column.lineIndexes,
        readingOrderLineIndexes: columnFirstOrder(column.lineIndexes, input.lines, column.box)
      });
      column.lineIndexes.forEach((index) => claimed.add(index));
    }
    for (const group of groups.sort((a, b) =>
      input.lines[a.anchorLineIndex]!.box.y - input.lines[b.anchorLineIndex]!.box.y ||
      input.lines[a.anchorLineIndex]!.box.x - input.lines[b.anchorLineIndex]!.box.x
    )) {
      drafts.push({
        role: 'entry',
        sectionHeadingLineIndex: scope.headingLineIndex,
        confidence: group.confidence,
        box: group.box,
        lineIndexes: group.lineIndexes,
        readingOrderLineIndexes: entryReadingOrder(group, input.lines)
      });
      group.lineIndexes.forEach((index) => claimed.add(index));
    }
    draftGroups.push({ box: scope.box, header: false, drafts });
  }

  const unclaimed = input.lines.map((_, index) => index).filter((index) => !claimed.has(index));
  const firstSectionY = confirmedScopes.length > 0
    ? Math.min(...confirmedScopes.map((scope) => input.lines[scope.headingLineIndex]!.box.y))
    : Number.POSITIVE_INFINITY;
  const headerIndexes = input.pageNumber === 1 && confirmedScopes.length > 0
    ? unclaimed.filter((index) => input.lines[index]!.box.y < firstSectionY)
    : [];
  if (headerIndexes.length > 0) {
    const box = unionBox(input.lines, headerIndexes);
    draftGroups.push({
      box,
      header: true,
      drafts: [{
        role: 'independent',
        sectionHeadingLineIndex: null,
        confidence: 0.5,
        box,
        lineIndexes: headerIndexes,
        readingOrderLineIndexes: rowAwareOrder(headerIndexes, input.lines, headingIndexes)
      }]
    });
  }
  const headerSet = new Set(headerIndexes);
  const remainingUnclaimed = unclaimed.filter((index) => !headerSet.has(index));
  const components = flowComponents(remainingUnclaimed, input.lines, true).sort((first, second) => {
    const firstBox = unionBox(input.lines, first);
    const secondBox = unionBox(input.lines, second);
    return firstBox.y - secondBox.y || firstBox.x - secondBox.x;
  });
  if (input.pageNumber === 1 && confirmedScopes.length === 0 && components.length > 0) {
    const first = components[0]!;
    const box = unionBox(input.lines, first);
    draftGroups.push({
      box,
      header: true,
      drafts: [{
        role: 'independent',
        sectionHeadingLineIndex: null,
        confidence: 0.5,
        box,
        lineIndexes: first,
        readingOrderLineIndexes: rowAwareOrder(first, input.lines, headingIndexes)
      }]
    });
    components.shift();
  }
  for (const component of components) {
    const box = unionBox(input.lines, component);
    draftGroups.push({
      box,
      header: false,
      drafts: [{
        role: 'independent',
        sectionHeadingLineIndex: null,
        confidence: 0.5,
        box,
        lineIndexes: component,
        readingOrderLineIndexes: rowAwareOrder(component, input.lines, headingIndexes)
      }]
    });
  }

  const drafts = draftGroups
    .sort((first, second) =>
      Number(second.header) - Number(first.header) ||
      first.box.y - second.box.y ||
      first.box.x - second.box.x
    )
    .flatMap((group) => group.drafts);
  const regions: FinalRegionDraft[] = drafts.map((draft, index) => ({
    ...draft,
    index,
    parentIndex: null
  }));
  const sectionRegionIndexes = new Map<number, number>();
  for (const region of regions) {
    if (region.role === 'section' && region.sectionHeadingLineIndex !== null) {
      sectionRegionIndexes.set(region.sectionHeadingLineIndex, region.index);
    }
  }
  for (const region of regions) {
    if (
      !['entry', 'content'].includes(region.role) ||
      region.sectionHeadingLineIndex === null
    ) {
      continue;
    }
    region.parentIndex = sectionRegionIndexes.get(region.sectionHeadingLineIndex) ?? null;
  }
  return regions;
}

function assertUniqueFinalOwnership(regions: FinalRegionDraft[], lineCount: number): void {
  const owners = new Map<number, number>();
  for (const region of regions) {
    const readingOrder = new Set(region.readingOrderLineIndexes);
    const owned = new Set(region.lineIndexes);
    if (
      readingOrder.size !== region.readingOrderLineIndexes.length ||
      readingOrder.size !== owned.size ||
      [...readingOrder].some((lineIndex) => !owned.has(lineIndex))
    ) {
      throw new Error(
        `Layout invariant failed: region ${region.index} reading order must contain each owned line exactly once`
      );
    }
    for (const lineIndex of region.lineIndexes) {
      const existing = owners.get(lineIndex);
      if (existing !== undefined) {
        throw new Error(
          `Layout invariant failed: line ${lineIndex + 1} belongs to regions ${existing} and ${region.index}`
        );
      }
      owners.set(lineIndex, region.index);
    }
  }
  if (owners.size !== lineCount) {
    throw new Error(
      `Layout invariant failed: ${lineCount - owners.size} reconstructed lines have no final owner`
    );
  }
}

function aiInputLines(
  pageNumber: number,
  regions: FinalRegionDraft[],
  lines: LayoutLine[],
  lineReferences?: number[]
): string[] {
  return regions.flatMap((region) => [
    `[P${pageNumber} R${region.index} ${region.role}${region.parentIndex === null ? '' : ` parent R${region.parentIndex}`}]`,
    ...region.readingOrderLineIndexes.map((lineIndex) =>
      `L${lineReferences?.[lineIndex] ?? lineIndex + 1} ${lines[lineIndex]!.text}`
    )
  ]);
}

export function resolveFinalLayout(input: FinalLayoutInput): FinalLayoutResolution {
  const validatedZones = validateZones(input);
  const sectionColumns = resolveSectionColumns(input);
  const regions = createRegions(input, sectionColumns);
  assertUniqueFinalOwnership(regions, input.lines.length);
  return {
    validatedZones,
    sectionColumns,
    regions,
    aiInputLines: aiInputLines(
      input.pageNumber,
      regions,
      input.lines,
      input.lineReferences
    )
  };
}
