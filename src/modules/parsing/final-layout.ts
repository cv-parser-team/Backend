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
  const metadata = rowAwareOrder(rest.filter((index) => isMetadata(lines[index]!.text)), lines);
  const body = rowAwareOrder(rest.filter((index) => !isMetadata(lines[index]!.text)), lines);
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

interface LocalColumnSplit {
  parts: [number[], number[]];
  confidence: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function repeatedLeftEdgeClusters(
  indexes: number[],
  lines: LayoutLine[],
  tolerance: number
): { value: number; indexes: number[] }[] {
  const clusters: { value: number; indexes: number[] }[] = [];
  for (const index of [...indexes].sort((a, b) => lines[a]!.box.x - lines[b]!.box.x)) {
    const x = lines[index]!.box.x;
    const cluster = clusters.find((candidate) => Math.abs(candidate.value - x) <= tolerance);
    if (cluster) {
      cluster.indexes.push(index);
      cluster.value = median(cluster.indexes.map((lineIndex) => lines[lineIndex]!.box.x));
    } else {
      clusters.push({ value: x, indexes: [index] });
    }
  }
  return clusters.sort((a, b) => a.value - b.value);
}

function verticalOverlap(indexes: number[], lines: LayoutLine[]): { top: number; bottom: number } {
  return {
    top: Math.min(...indexes.map((index) => lines[index]!.box.y)),
    bottom: Math.max(...indexes.map((index) => bottom(lines[index]!.box)))
  };
}

function isStandaloneMetadata(text: string): boolean {
  const normalized = normalizeSemanticText(text).trim();
  return /^(?:(?:19|20)\d{2})(?:\s*[-–—|/]\s*(?:(?:19|20)\d{2}|present|now))?$/iu.test(
    normalized
  );
}

function localColumnSplit(
  scope: SectionScope,
  indexes: number[],
  lines: LayoutLine[]
): LocalColumnSplit | null {
  if (indexes.length < 4) {
    return null;
  }
  const usualHeight = median(indexes.map((index) => lines[index]!.box.height));
  const clusters = repeatedLeftEdgeClusters(indexes, lines, Math.max(2, usualHeight * 0.35));
  const minimumGutter = Math.max(usualHeight * 1.5, scope.box.width * 0.03);
  const candidates: (LocalColumnSplit & { gutter: number })[] = [];

  for (let clusterIndex = 0; clusterIndex < clusters.length - 1; clusterIndex += 1) {
    const leftClusters = clusters.slice(0, clusterIndex + 1);
    const rightClusters = clusters.slice(clusterIndex + 1);
    if (
      Math.max(...leftClusters.map((cluster) => cluster.indexes.length)) < 2 ||
      Math.max(...rightClusters.map((cluster) => cluster.indexes.length)) < 2
    ) {
      continue;
    }
    const left = leftClusters.flatMap((cluster) => cluster.indexes);
    const rightIndexes = rightClusters.flatMap((cluster) => cluster.indexes);
    if (left.length < 2 || rightIndexes.length < 2) {
      continue;
    }
    const gutterStart = Math.max(...left.map((index) => right(lines[index]!.box)));
    const gutterEnd = Math.min(...rightIndexes.map((index) => lines[index]!.box.x));
    const gutter = gutterEnd - gutterStart;
    if (gutter < minimumGutter) {
      continue;
    }
    const leftRange = verticalOverlap(left, lines);
    const rightRange = verticalOverlap(rightIndexes, lines);
    const overlap = Math.min(leftRange.bottom, rightRange.bottom) -
      Math.max(leftRange.top, rightRange.top);
    if (overlap < usualHeight) {
      continue;
    }
    if (
      left.every((index) => isStandaloneMetadata(lines[index]!.text)) ||
      rightIndexes.every((index) => isStandaloneMetadata(lines[index]!.text))
    ) {
      continue;
    }
    const balance = Math.min(left.length, rightIndexes.length) /
      Math.max(left.length, rightIndexes.length);
    if (balance < 0.35) {
      continue;
    }
    candidates.push({
      parts: [
        left.sort((a, b) => lines[a]!.box.y - lines[b]!.box.y || a - b),
        rightIndexes.sort((a, b) => lines[a]!.box.y - lines[b]!.box.y || a - b)
      ],
      confidence: round(Math.min(0.95, 0.7 + balance * 0.15 + gutter / scope.box.width)),
      gutter
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence || b.gutter - a.gutter)[0] ?? null;
}

function resolveSectionColumns(
  input: FinalLayoutInput,
  validatedZones: ValidatedLayoutZone[]
): SectionColumn[] {
  return input.sectionScopes
    .filter((scope) => scope.status === 'confirmed' && scope.mode === 'cross-lane')
    .flatMap<SectionColumn>((scope) => {
      const scopeIndexes = new Set(scope.lineIndexes);
      const groupedIndexes = new Set(
        input.entryGroups
          .filter((group) => group.sectionHeadingLineIndex === scope.headingLineIndex)
          .flatMap((group) => group.lineIndexes)
      );
      const headingContinuations = new Set(
        splitHeadingContinuations(scope, scope.lineIndexes, input.lines)
      );
      const candidates = validatedZones
        .filter((validated) => validated.accepted)
        .map((validated) => ({
          validated,
          zone: input.layoutZoneCandidates[validated.candidateIndex]!
        }))
        .filter(({ zone }) =>
          zone.boundaryBox !== null && zone.boundaryBox.width < zone.boundaryBox.height
        )
        .sort((a, b) => b.validated.confidence - a.validated.confidence);

      for (const { validated, zone } of candidates) {
        const parts = zone.parts
          .map((part) => part.lineIndexes.filter((index) =>
            index !== scope.headingLineIndex && scopeIndexes.has(index)
          ))
          .filter((indexes) => indexes.length > 0);
        if (parts.length !== 2) {
          continue;
        }
        const overlap = parts[0]!.some((index) => parts[1]!.includes(index));
        if (overlap) {
          continue;
        }
        return parts.map((lineIndexes) => ({
          sectionHeadingLineIndex: scope.headingLineIndex,
          lineIndexes,
          box: unionBox(input.lines, lineIndexes),
          confidence: validated.confidence,
          source: 'layout-zone' as const
        }));
      }
      const localIndexes = scope.lineIndexes.filter(
        (index) =>
          index !== scope.headingLineIndex &&
          !headingContinuations.has(index) &&
          !groupedIndexes.has(index)
      );
      const local = localColumnSplit(scope, localIndexes, input.lines);
      if (local) {
        return local.parts.map((lineIndexes) => ({
          sectionHeadingLineIndex: scope.headingLineIndex,
          lineIndexes,
          box: unionBox(input.lines, lineIndexes),
          confidence: local.confidence,
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
  const drafts: Omit<FinalRegionDraft, 'index' | 'parentIndex'>[] = [];
  const sectionDraftIndexes = new Map<number, number>();
  const headingIndexes = new Set(input.sectionScopes.map((scope) => scope.headingLineIndex));

  for (const scope of confirmedScopes) {
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
      sectionDraftIndexes.set(scope.headingLineIndex, drafts.length);
      drafts.push({
        role: 'section',
        sectionHeadingLineIndex: scope.headingLineIndex,
        confidence: scope.confidence,
        box: unionBox(input.lines, direct),
        lineIndexes: direct,
        readingOrderLineIndexes: [
          scope.headingLineIndex,
          ...headingContinuations,
          ...rowAwareOrder(
            direct.filter(
              (index) =>
                index !== scope.headingLineIndex && !headingContinuationSet.has(index)
            ),
            input.lines,
            headingIndexes
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
        readingOrderLineIndexes: rowAwareOrder(column.lineIndexes, input.lines)
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
  }

  const unclaimed = input.lines.map((_, index) => index).filter((index) => !claimed.has(index));
  if (unclaimed.length > 0) {
    drafts.unshift({
      role: 'independent',
      sectionHeadingLineIndex: null,
      confidence: 0.5,
      box: unionBox(input.lines, unclaimed),
      lineIndexes: unclaimed,
      readingOrderLineIndexes: rowAwareOrder(unclaimed, input.lines, headingIndexes)
    });
  }

  const regions: FinalRegionDraft[] = drafts.map((draft, index) => ({
    ...draft,
    index,
    parentIndex: null
  }));
  const offset = unclaimed.length > 0 ? 1 : 0;
  for (const region of regions) {
    if (
      !['entry', 'content'].includes(region.role) ||
      region.sectionHeadingLineIndex === null
    ) {
      continue;
    }
    const parentDraftIndex = sectionDraftIndexes.get(region.sectionHeadingLineIndex);
    region.parentIndex = parentDraftIndex === undefined ? null : parentDraftIndex + offset;
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
  const sectionColumns = resolveSectionColumns(input, validatedZones);
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
