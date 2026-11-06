import type { Association, EntryGroup } from './entry-groups.js';
import type { LayoutLine } from './layout.js';
import type { LayoutZoneCandidate } from './macro-layout.js';
import type { SectionScope } from './section-scopes.js';
import type { BoundingBox } from './parsing.types.js';

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
  associations: Association[];
  entryGroups: EntryGroup[];
  lineReferences?: number[];
}

const METADATA = /(?:\b(?:19|20)\d{2}\b|\b(?:present|now)\b|@|https?:\/\/|www\.|\+?\d[\d ().-]{6,}\d)/iu;

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
  return input.layoutZoneCandidates.map((zone, candidateIndex) => {
    const reasons = [...zone.reasons];
    if (!zone.boundaryBox || zone.boundaryBox.width >= zone.boundaryBox.height) {
      return {
        candidateIndex,
        accepted: zone.kind === 'header-body' || zone.kind === 'full-width-section',
        confidence: zone.confidence,
        reasons
      };
    }
    if (zone.kind === 'unresolved-gutter') {
      return {
        candidateIndex,
        accepted: false,
        confidence: zone.confidence,
        reasons: [...reasons, 'ambiguous gutter remains unsplit']
      };
    }
    const cutGroup = input.entryGroups.find((group) =>
      crossesVerticalBoundary(group.lineIndexes, zone.boundaryBox!, input.lines)
    );
    if (cutGroup) {
      return {
        candidateIndex,
        accepted: false,
        confidence: zone.confidence,
        reasons: [...reasons, `rejected because it divides entry anchored at line ${cutGroup.anchorLineIndex + 1}`]
      };
    }
    const protectedAssociation = input.associations.find((association) =>
      association.confidence >= 0.75 &&
      crossesVerticalBoundary(association.lineIndexes, zone.boundaryBox!, input.lines)
    );
    if (protectedAssociation) {
      return {
        candidateIndex,
        accepted: false,
        confidence: zone.confidence,
        reasons: [...reasons, `rejected because it cuts a protected ${protectedAssociation.kind} association`]
      };
    }
    reasons.push('accepted without dividing a protected association or entry group');
    return { candidateIndex, accepted: true, confidence: zone.confidence, reasons };
  });
}

function geometricOrder(indexes: number[], lines: LayoutLine[]): number[] {
  return [...indexes].sort((a, b) =>
    lines[a]!.box.y - lines[b]!.box.y || lines[a]!.box.x - lines[b]!.box.x || a - b
  );
}

function entryReadingOrder(group: EntryGroup, lines: LayoutLine[]): number[] {
  const rest = group.lineIndexes.filter((index) => index !== group.anchorLineIndex);
  const metadata = geometricOrder(rest.filter((index) => METADATA.test(lines[index]!.text)), lines);
  const body = geometricOrder(rest.filter((index) => !METADATA.test(lines[index]!.text)), lines);
  return [group.anchorLineIndex, ...metadata, ...body];
}

function resolveSectionColumns(
  input: FinalLayoutInput,
  validatedZones: ValidatedLayoutZone[]
): SectionColumn[] {
  return input.sectionScopes
    .filter((scope) => scope.status === 'confirmed' && scope.mode === 'cross-lane')
    .flatMap((scope) => {
      const scopeIndexes = new Set(scope.lineIndexes);
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
          confidence: validated.confidence
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
      sectionDraftIndexes.set(scope.headingLineIndex, drafts.length);
      drafts.push({
        role: 'section',
        sectionHeadingLineIndex: scope.headingLineIndex,
        confidence: scope.confidence,
        box: unionBox(input.lines, direct),
        lineIndexes: direct,
        readingOrderLineIndexes: [
          scope.headingLineIndex,
          ...geometricOrder(direct.filter((index) => index !== scope.headingLineIndex), input.lines)
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
        readingOrderLineIndexes: geometricOrder(column.lineIndexes, input.lines)
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
      readingOrderLineIndexes: geometricOrder(unclaimed, input.lines)
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
