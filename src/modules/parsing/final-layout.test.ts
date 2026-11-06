import { describe, expect, it } from 'vitest';
import type { EntryGroup } from './entry-groups.js';
import { resolveFinalLayout } from './final-layout.js';
import type { LayoutLine } from './layout.js';
import type { LayoutZoneCandidate } from './macro-layout.js';
import type { SectionScope } from './section-scopes.js';

function line(text: string, x: number, y: number, width: number): LayoutLine {
  return {
    text,
    box: { x, y, width, height: 10 },
    bold: false,
    italic: false,
    bullet: false,
    links: []
  };
}

describe('constrained final layout', () => {
  it('rejects a gutter that divides an entry and produces unique final ownership', () => {
    const lines = [
      line('Candidate', 50, 30, 120),
      line('EXPERIENCE', 50, 100, 100),
      line('2022 - Present', 50, 140, 90),
      line('Backend Engineer', 230, 140, 140),
      line('Built services.', 230, 160, 200)
    ];
    const scope: SectionScope = {
      headingLineIndex: 1,
      lineIndexes: [1, 2, 3, 4],
      box: { x: 50, y: 100, width: 380, height: 70 },
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 0.9,
      reasons: [],
      governingZoneCandidateIndexes: [0]
    };
    const group: EntryGroup = {
      anchorLineIndex: 3,
      sectionHeadingLineIndex: 1,
      lineIndexes: [2, 3, 4],
      box: { x: 50, y: 140, width: 380, height: 30 },
      confidence: 0.9,
      associationIndexes: []
    };
    const zone: LayoutZoneCandidate = {
      kind: 'parallel-columns',
      box: { x: 50, y: 100, width: 380, height: 70 },
      boundaryBox: { x: 180, y: 100, width: 20, height: 70 },
      confidence: 0.85,
      reasons: [],
      participatingLineIndexes: [1, 2, 3, 4],
      parts: []
    };
    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [zone],
      sectionScopes: [scope],
      associations: [],
      entryGroups: [group]
    });

    expect(result.validatedZones[0]).toMatchObject({ accepted: false });
    expect(result.regions.map((region) => [region.role, region.parentIndex])).toEqual([
      ['independent', null],
      ['section', null],
      ['entry', 1]
    ]);
    const owned = result.regions.flatMap((region) => region.lineIndexes);
    expect(new Set(owned).size).toBe(lines.length);
    expect(owned).toHaveLength(lines.length);
    expect(result.regions[2]!.readingOrderLineIndexes).toEqual([3, 2, 4]);
    expect(result.aiInputLines[0]).toBe('[P1 R0 independent]');
  });

  it('creates disjoint content columns inside their owning section', () => {
    const lines = [
      line('SKILLS', 50, 100, 80),
      line('TypeScript', 50, 140, 80),
      line('PostgreSQL', 50, 160, 80),
      line('English', 300, 140, 70),
      line('Arabic', 300, 160, 60)
    ];
    const scope: SectionScope = {
      headingLineIndex: 0,
      lineIndexes: [0, 1, 2, 3, 4],
      box: { x: 50, y: 100, width: 320, height: 70 },
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 0.9,
      reasons: [],
      governingZoneCandidateIndexes: [0]
    };
    const zone: LayoutZoneCandidate = {
      kind: 'parallel-columns',
      box: scope.box,
      boundaryBox: { x: 180, y: 120, width: 30, height: 60 },
      confidence: 0.85,
      reasons: [],
      participatingLineIndexes: [0, 1, 2, 3, 4],
      parts: [
        { label: 'left-lane', box: { x: 50, y: 140, width: 80, height: 30 }, lineIndexes: [1, 2] },
        { label: 'right-lane', box: { x: 300, y: 140, width: 70, height: 30 }, lineIndexes: [3, 4] }
      ]
    };

    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [zone],
      sectionScopes: [scope],
      associations: [],
      entryGroups: []
    });

    expect(result.sectionColumns.map((column) => column.lineIndexes)).toEqual([[1, 2], [3, 4]]);
    expect(result.regions.map((region) => [region.role, region.parentIndex])).toEqual([
      ['section', null],
      ['content', 0],
      ['content', 0]
    ]);
    expect(result.regions[0]!.lineIndexes).toEqual([0]);
  });

  it('keeps crossing grid cells together instead of creating columns', () => {
    const lines = [
      line('SKILLS', 50, 100, 80),
      line('TypeScript', 50, 140, 80),
      line('Advanced', 300, 140, 70),
      line('Shared row label', 150, 160, 140)
    ];
    const scope: SectionScope = {
      headingLineIndex: 0,
      lineIndexes: [0, 1, 2, 3],
      box: { x: 50, y: 100, width: 320, height: 70 },
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 0.9,
      reasons: [],
      governingZoneCandidateIndexes: [0]
    };
    const zone: LayoutZoneCandidate = {
      kind: 'parallel-columns',
      box: scope.box,
      boundaryBox: { x: 180, y: 120, width: 30, height: 60 },
      confidence: 0.85,
      reasons: [],
      participatingLineIndexes: [0, 1, 2, 3],
      parts: [
        { label: 'left-lane', box: scope.box, lineIndexes: [1, 3] },
        { label: 'right-lane', box: scope.box, lineIndexes: [2, 3] }
      ]
    };

    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [zone],
      sectionScopes: [scope],
      associations: [],
      entryGroups: []
    });

    expect(result.sectionColumns).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({ role: 'section', lineIndexes: [0, 1, 2, 3] });
  });
});
