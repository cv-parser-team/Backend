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
  it('keeps a split section heading together before same-row content', () => {
    const lines = [
      line('PROFESSIONAL', 50, 100, 90),
      line('Current role', 220, 100, 100),
      line('EXPERIENCE', 50, 113, 90)
    ];
    lines[0]!.bold = true;
    lines[2]!.bold = true;
    const scope: SectionScope = {
      headingLineIndex: 0,
      lineIndexes: [0, 1, 2],
      box: { x: 50, y: 100, width: 270, height: 23 },
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 0.9,
      reasons: [],
      governingZoneCandidateIndexes: []
    };
    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [],
      sectionScopes: [scope],
      entryGroups: []
    });

    expect(result.regions[0]!.readingOrderLineIndexes).toEqual([0, 2, 1]);
  });

  it('keeps a provisional heading diagnostic-only', () => {
    const lines = [
      line('CONTACT', 50, 100.5, 80),
      line('Phone: 123-456-7890', 160, 100, 130)
    ];
    const provisional: SectionScope = {
      headingLineIndex: 0,
      lineIndexes: [0, 1],
      box: { x: 50, y: 100, width: 240, height: 10.5 },
      status: 'provisional',
      mode: 'cross-lane',
      confidence: 0.7,
      reasons: [],
      governingZoneCandidateIndexes: []
    };
    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [],
      sectionScopes: [provisional],
      entryGroups: []
    });

    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({
      role: 'independent',
      sectionHeadingLineIndex: null,
      readingOrderLineIndexes: [0, 1]
    });
  });

  it('separates the first-page header from distant unclaimed content', () => {
    const lines = [
      line('SAMPLE CANDIDATE', 180, 30, 220),
      line('hello@example.com', 210, 55, 160),
      line('SUMMARY', 40, 120, 80),
      line('Experienced engineer.', 40, 150, 300),
      line('Professional', 160, 700, 80),
      line('TypeScript', 160, 725, 70)
    ];
    const scope: SectionScope = {
      headingLineIndex: 2,
      lineIndexes: [2, 3],
      box: { x: 40, y: 120, width: 300, height: 40 },
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 1,
      reasons: [],
      governingZoneCandidateIndexes: []
    };

    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [],
      sectionScopes: [scope],
      entryGroups: []
    });

    expect(result.regions.map((region) => [region.role, region.lineIndexes])).toEqual([
      ['independent', [0, 1]],
      ['section', [2, 3]],
      ['independent', [4, 5]]
    ]);
  });

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
      confidence: 0.9
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

  it('detects clean section-local columns without a page-wide layout zone', () => {
    const lines = [
      line('CERTIFICATES', 34, 100, 75),
      line('Project Management | 2027', 140, 100, 133),
      line('System Optimization | 2028', 362, 100, 135),
      line('The Project Management Institute', 140, 116, 157),
      line('Scrum Learning Society', 362, 116, 110),
      line('Risk Management and Mitigation | 2028', 140, 146, 191),
      line('Vendor Relations | 2030', 362, 146, 116),
      line('Internal Auditors Team', 140, 163, 105),
      line('South City College', 362, 163, 86)
    ];
    lines[0]!.bold = true;
    lines[1]!.bold = true;
    lines[2]!.bold = true;
    lines[5]!.bold = true;
    lines[6]!.bold = true;
    const scope: SectionScope = {
      headingLineIndex: 0,
      lineIndexes: lines.map((_, index) => index),
      box: { x: 34, y: 100, width: 463, height: 73 },
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 1,
      reasons: [],
      governingZoneCandidateIndexes: []
    };

    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [],
      sectionScopes: [scope],
      entryGroups: []
    });

    expect(result.sectionColumns.map((column) => column.lineIndexes)).toEqual([
      [1, 3, 5, 7],
      [2, 4, 6, 8]
    ]);
    expect(result.sectionColumns.every((column) => column.source === 'section-local')).toBe(true);
    expect(result.regions.map((region) => region.readingOrderLineIndexes)).toEqual([
      [0],
      [1, 3, 5, 7],
      [2, 4, 6, 8]
    ]);
    expect(result.aiInputLines).toEqual([
      '[P1 R0 section]',
      'L1 CERTIFICATES',
      '[P1 R1 content parent R0]',
      'L2 Project Management | 2027',
      'L4 The Project Management Institute',
      'L6 Risk Management and Mitigation | 2028',
      'L8 Internal Auditors Team',
      '[P1 R2 content parent R0]',
      'L3 System Optimization | 2028',
      'L5 Scrum Learning Society',
      'L7 Vendor Relations | 2030',
      'L9 South City College'
    ]);
  });

  it('reads every lane top-to-bottom before advancing across a multi-column section', () => {
    const lines = [
      line('SKILLS', 40, 100, 60),
      line('TypeScript', 140, 140, 70),
      line('PostgreSQL', 140, 160, 70),
      line('Docker', 290, 140, 50),
      line('Kubernetes', 290, 160, 70),
      line('English', 440, 140, 55),
      line('Arabic', 440, 160, 50)
    ];
    lines[0]!.bold = true;
    const scope: SectionScope = {
      headingLineIndex: 0,
      lineIndexes: lines.map((_, index) => index),
      box: { x: 40, y: 100, width: 455, height: 70 },
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 1,
      reasons: [],
      governingZoneCandidateIndexes: []
    };

    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [],
      sectionScopes: [scope],
      entryGroups: []
    });

    expect(result.sectionColumns.map((column) => column.lineIndexes)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6]
    ]);
    expect(result.regions.map((region) => region.readingOrderLineIndexes)).toEqual([
      [0],
      [1, 2],
      [3, 4],
      [5, 6]
    ]);
  });

  it('does not mistake indentation inside one section lane for separate columns', () => {
    const lines = [
      line('EXPERIENCE', 34, 100, 75),
      line('Research Engineer | 2022-2025', 140, 100, 180),
      line('Innovation Lab', 140, 117, 90),
      line('Built a long system that crosses any indentation gap.', 157, 140, 300),
      line('Improved reliability across the platform.', 157, 156, 230)
    ];
    lines[0]!.bold = true;
    lines[1]!.bold = true;
    const scope: SectionScope = {
      headingLineIndex: 0,
      lineIndexes: lines.map((_, index) => index),
      box: { x: 34, y: 100, width: 423, height: 66 },
      status: 'confirmed',
      mode: 'cross-lane',
      confidence: 1,
      reasons: [],
      governingZoneCandidateIndexes: []
    };

    const result = resolveFinalLayout({
      pageNumber: 1,
      lines,
      layoutZoneCandidates: [],
      sectionScopes: [scope],
      entryGroups: []
    });

    expect(result.sectionColumns).toEqual([]);
    expect(result.regions).toHaveLength(1);
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
      entryGroups: []
    });

    expect(result.sectionColumns).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({ role: 'section', lineIndexes: [0, 1, 2, 3] });
  });
});
