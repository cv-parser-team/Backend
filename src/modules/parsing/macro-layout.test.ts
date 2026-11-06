import { describe, expect, it } from 'vitest';
import { generateBoundaryCandidates } from './boundary-candidates.js';
import { measurePageMetrics, type LayoutLine } from './layout.js';
import { generateLayoutZoneCandidates } from './macro-layout.js';
import type { DrawnSeparator } from './parsing.types.js';

function line(
  text: string,
  x: number,
  y: number,
  width: number,
  height = 10,
  bold = false
): LayoutLine {
  return {
    text,
    box: { x, y, width, height },
    bold,
    italic: false,
    bullet: false,
    links: []
  };
}

function generate(
  lines: LayoutLine[],
  separators: DrawnSeparator[] = [],
  pageIndex = 0
) {
  const metrics = measurePageMetrics(lines, separators);
  const boundaries = generateBoundaryCandidates({
    lines,
    metrics,
    separators,
    pageIndex,
    pageHeight: 800
  });
  return generateLayoutZoneCandidates({
    lines,
    metrics,
    boundaryCandidates: boundaries.lines,
    nonTextBoundaryCandidates: boundaries.nonText,
    pageIndex,
    pageWidth: 600,
    pageHeight: 800
  });
}

describe('provisional macro layout hypotheses', () => {
  it('proposes a full-width header above the body', () => {
    const lines = [
      line('SAMPLE CANDIDATE', 100, 30, 350, 24, true),
      line('sample@example.com', 100, 65, 160),
      line('EXPERIENCE', 50, 120, 100, 14, true),
      line('Built reliable systems.', 50, 150, 400)
    ];
    const separator: DrawnSeparator = {
      orientation: 'horizontal',
      box: { x: 50, y: 95, width: 400, height: 1 },
      thickness: 1
    };
    const header = generate(lines, [separator]).find(
      (candidate) => candidate.kind === 'header-body'
    );

    expect(header).toBeDefined();
    expect(header!.parts.map((part) => [part.label, part.lineIndexes])).toEqual([
      ['header', [0, 1]],
      ['body', [2, 3]]
    ]);
    expect(header!.boundaryBox).not.toBeNull();
  });

  it('proposes a narrow persistent sidebar without assigning ownership', () => {
    const lines = [
      line('Contact', 40, 80, 70, 12, true),
      line('Amman', 40, 105, 70),
      line('Skills', 40, 135, 70, 12, true),
      line('TypeScript', 40, 160, 70),
      line('Experience', 200, 90, 300, 14, true),
      line('Backend Engineer', 200, 120, 300, 11, true),
      line('Built APIs and services.', 200, 150, 300),
      line('Improved system reliability.', 200, 180, 300)
    ];
    const sidebar = generate(lines).find((candidate) => candidate.kind === 'sidebar-main');

    expect(sidebar).toBeDefined();
    expect(sidebar!.participatingLineIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(sidebar!.parts.map((part) => part.label)).toEqual(['left-lane', 'right-lane']);
  });

  it('requires independent section evidence for parallel columns', () => {
    const lines = [
      line('PROJECTS', 40, 80, 220, 14, true),
      line('Project Alpha', 40, 115, 220, 10, true),
      line('Built an internal platform.', 40, 145, 220),
      line('EDUCATION', 340, 95, 220, 14, true),
      line('Example University', 340, 130, 220, 10, true),
      line('Computer Science degree.', 340, 160, 220)
    ];

    expect(generate(lines).some((candidate) => candidate.kind === 'parallel-columns')).toBe(true);
  });

  it('does not treat shared rows as a table or grid signal', () => {
    const lines = [
      line('Role', 40, 80, 180, 10, true),
      line('Company', 300, 80, 180, 10, true),
      line('Engineer', 40, 110, 180),
      line('Example Corp', 300, 110, 180),
      line('Intern', 40, 140, 180),
      line('Sample Labs', 300, 140, 180)
    ];
    const zones = generate(lines, [], 1);

    expect(zones.some((candidate) => candidate.kind === 'unresolved-gutter')).toBe(true);
    expect(zones.flatMap((candidate) => candidate.reasons).join(' ')).not.toMatch(/table|grid/);
  });

  it('leaves right-aligned date rails unresolved', () => {
    const lines = [
      line('Backend Engineer', 40, 80, 220, 10, true),
      line('2022 - Present', 400, 80, 100),
      line('Software Engineer', 40, 110, 220, 10, true),
      line('2020 - 2022', 400, 110, 100),
      line('Engineering Intern', 40, 140, 220, 10, true),
      line('2019 - 2020', 400, 140, 100)
    ];
    const zones = generate(lines, [], 1);

    expect(zones.some((candidate) => candidate.kind === 'unresolved-gutter')).toBe(true);
    expect(zones.some((candidate) => candidate.kind !== 'unresolved-gutter')).toBe(false);
  });

  it('keeps a line crossing a provisional gutter in both visual parts', () => {
    const lines = [
      line('SAMPLE CANDIDATE', 40, 30, 460, 24, true),
      line('Contact', 40, 100, 70, 12, true),
      line('Amman', 40, 130, 70),
      line('Experience', 200, 105, 300, 14, true),
      line('Built reliable systems.', 200, 140, 300)
    ];
    const gutter = generate(lines).find((candidate) =>
      candidate.kind === 'sidebar-main' || candidate.kind === 'unresolved-gutter'
    );

    expect(gutter).toBeDefined();
    expect(gutter!.parts[0]!.lineIndexes).toContain(0);
    expect(gutter!.parts[1]!.lineIndexes).toContain(0);
  });

  it('proposes a full-width section only with supporting horizontal evidence', () => {
    const lines = [
      line('EXPERIENCE', 50, 100, 110, 14, true),
      line('Backend Engineer', 50, 135, 200, 10, true),
      line('Built reliable services.', 50, 160, 400)
    ];
    const separator: DrawnSeparator = {
      orientation: 'horizontal',
      box: { x: 50, y: 120, width: 400, height: 1 },
      thickness: 1
    };

    expect(
      generate(lines, [separator], 1).some(
        (candidate) => candidate.kind === 'full-width-section'
      )
    ).toBe(true);
    expect(
      generate(lines, [], 1).some(
        (candidate) => candidate.kind === 'full-width-section'
      )
    ).toBe(false);
  });

  it('does not treat a multi-cell row as a full-width section', () => {
    const lines = [
      line('2022 - Present', 50, 100, 100, 10, true),
      line('Backend Engineer', 250, 100, 180, 14, true),
      line('Built reliable services.', 250, 135, 300)
    ];
    const separator: DrawnSeparator = {
      orientation: 'horizontal',
      box: { x: 50, y: 120, width: 380, height: 1 },
      thickness: 1
    };

    expect(
      generate(lines, [separator], 1).some(
        (candidate) => candidate.kind === 'full-width-section'
      )
    ).toBe(false);
  });
});
