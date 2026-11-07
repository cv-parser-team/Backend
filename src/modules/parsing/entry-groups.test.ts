import { describe, expect, it } from 'vitest';
import type { BoundaryCandidate } from './boundary-candidates.js';
import { resolveEntries } from './entry-groups.js';
import { measurePageMetrics, type LayoutLine } from './layout.js';
import type { SectionScope } from './section-scopes.js';

function line(text: string, x: number, y: number, width: number, bold = false): LayoutLine {
  return {
    text,
    box: { x, y, width, height: 10 },
    bold,
    italic: false,
    bullet: false,
    links: []
  };
}

function candidate(lineIndex: number, entry: number, section = 0): BoundaryCandidate {
  const evidence = (score: number) => ({ score, reasons: [] });
  return {
    lineIndex,
    header: evidence(0),
    section: evidence(section),
    entry: evidence(entry),
    content: evidence(0.5)
  };
}

function scope(lineIndexes: number[]): SectionScope {
  return {
    headingLineIndex: 0,
    lineIndexes,
    box: { x: 50, y: 100, width: 450, height: 150 },
    status: 'confirmed',
    mode: 'cross-lane',
    confidence: 0.9,
    reasons: [],
    governingZoneCandidateIndexes: []
  };
}

describe('entry resolution', () => {
  it('keeps a metadata rail with the title and body in the opposite rail', () => {
    const lines = [
      line('EXPERIENCE', 50, 100, 100, true),
      line('2022 - Present', 50, 140, 90),
      line('Example Company', 50, 155, 100),
      line('Backend Engineer', 220, 140, 140, true),
      line('Built reliable services.', 220, 158, 250),
      line('2020 - 2022', 50, 200, 90),
      line('Sample Labs', 50, 215, 90),
      line('Software Engineer', 220, 200, 145, true),
      line('Improved deployment safety.', 220, 218, 250)
    ];
    const boundaryCandidates = lines.map((_, index) =>
      candidate(index, [3, 7].includes(index) ? 0.9 : 0)
    );
    const result = resolveEntries({
      lines,
      metrics: measurePageMetrics(lines, []),
      boundaryCandidates,
      sectionScopes: [scope(lines.map((_, index) => index))]
    });

    expect(result.groups.map((group) => group.lineIndexes)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8]
    ]);
    expect(result.groups[0]!.lineIndexes).toContain(1);
  });

  it('keeps same-row reference cards separate by their nearest anchor lane', () => {
    const lines = [
      line('REFERENCES', 50, 100, 100, true),
      line('Aarya Agarwal', 50, 140, 90, true),
      line('Phone: 123-456-7890', 160, 140, 120),
      line('CEO of Example Company', 50, 158, 130),
      line('Sharin Varma', 320, 140, 90, true),
      line('Phone: 987-654-3210', 425, 140, 120),
      line('HRD of Example Company', 320, 158, 140)
    ];
    const boundaries = lines.map((_, index) =>
      candidate(index, [1, 4].includes(index) ? 0.8 : 0, [1, 4].includes(index) ? 0.65 : 0)
    );
    const provisional = [1, 4].map((headingLineIndex): SectionScope => ({
      ...scope([headingLineIndex]),
      headingLineIndex,
      status: 'provisional',
      mode: 'provisional-cell'
    }));
    const result = resolveEntries({
      lines,
      metrics: measurePageMetrics(lines, []),
      boundaryCandidates: boundaries,
      sectionScopes: [scope(lines.map((_, index) => index)), ...provisional]
    });

    expect(result.anchors.every((anchor) => anchor.demotedSectionCandidate)).toBe(true);
    expect(result.groups.map((group) => group.lineIndexes)).toEqual([
      [1, 2, 3],
      [4, 5, 6]
    ]);
  });

  it('does not demote a provisional heading when section evidence is stronger', () => {
    const lines = [
      line('EXPERIENCE', 50, 100, 100, true),
      line('EDUCATION', 50, 140, 90, true),
      line('Example University', 50, 160, 120)
    ];
    const boundaries = [
      candidate(0, 0.2, 0.9),
      candidate(1, 0.65, 0.8),
      candidate(2, 0.1, 0)
    ];
    const provisional: SectionScope = {
      ...scope([1, 2]),
      headingLineIndex: 1,
      status: 'provisional',
      mode: 'provisional-cell'
    };
    const result = resolveEntries({
      lines,
      metrics: measurePageMetrics(lines, []),
      boundaryCandidates: boundaries,
      sectionScopes: [scope([0, 1, 2]), provisional]
    });

    expect(result.anchors).toEqual([]);
  });
});
