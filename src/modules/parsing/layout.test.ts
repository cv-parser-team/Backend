import { describe, expect, it } from 'vitest';
import { buildPages, buildPagesWithTrace, measurePageMetrics, reconstructLines } from './layout.js';
import { ParsedPage, TextPiece } from './parsing.types.js';

// Each layout is written as positioned text pieces, so the expected regions
// are exact and no PDF is needed. Widths follow a 12 pt font, about 6 points
// per character.
function piece(text: string, x: number, y: number, size = 12, bold = false): TextPiece {
  return { text, box: { x, y, width: text.length * size * 0.5, height: size }, bold, italic: false, links: [] };
}

function layout(pieces: TextPiece[]): ParsedPage {
  return buildPages([
    { pageNumber: 1, width: 612, height: 792, pieces, marks: [], separators: [] }
  ])[0]!;
}

describe('visual line reconstruction', () => {
  it('merges PDF fragments and retains aggregate style and links without layout authority', () => {
    const first = {
      ...piece('Built', 100, 100, 10, true),
      links: ['https://example.com/profile']
    };
    const second = { ...piece('tools', 128, 100, 10, true), italic: true };

    const lines = reconstructLines([first, second], []);

    expect(lines).toEqual([{
      text: 'Built tools',
      box: { x: 100, y: 100, width: 53, height: 10 },
      bold: true,
      italic: false,
      bullet: false,
      links: ['https://example.com/profile']
    }]);
    expect(lines[0]).not.toHaveProperty('heading');
    expect(lines[0]).not.toHaveProperty('layoutAction');
  });

  it('does not infer a grid from repeated starts on nearby rows', () => {
    const lines = reconstructLines([
      piece('Stakeholder', 100, 100, 10),
      piece('Leadership', 168, 100, 10),
      piece('Commercial', 100, 116, 10),
      piece('Forecasting', 168, 116, 10)
    ], []);

    expect(lines.map((line) => line.text)).toEqual([
      'Stakeholder Leadership',
      'Commercial Forecasting'
    ]);
  });

  it('still separates same-row text across a wide gap', () => {
    const lines = reconstructLines([
      piece('Backend Developer', 100, 100, 10),
      piece('2024 - Present', 300, 100, 10)
    ], []);

    expect(lines.map((line) => line.text)).toEqual([
      'Backend Developer',
      '2024 - Present'
    ]);
  });

  it('removes overlaid copies without dropping distinct lines', () => {
    const lines = reconstructLines([
      piece('EDUCATION', 72, 100),
      piece('EDUCATION', 72, 101),
      piece('Sample University', 72, 120)
    ], []);

    expect(lines.map((line) => line.text)).toEqual(['EDUCATION', 'Sample University']);
  });

  it('attaches nearby drawn marks and preserves written bullet characters', () => {
    const lines = reconstructLines(
      [
        piece('Leadership', 90, 100),
        piece('• Analytics', 80, 116),
        piece('Unmarked', 300, 100)
      ],
      [{ x: 80, y: 104, width: 4, height: 4 }]
    );

    expect(lines.map((line) => [line.text, line.bullet])).toEqual([
      ['Leadership', true],
      ['Unmarked', false],
      ['• Analytics', true]
    ]);
  });
});

describe('page metrics', () => {
  it('uses the dominant body height instead of a large title', () => {
    const lines = reconstructLines([
      piece('LARGE TITLE', 72, 40, 30, true),
      piece('First body line', 72, 100, 10),
      piece('Second body line', 72, 120, 10),
      piece('Third body line', 72, 140, 10)
    ], []);

    expect(measurePageMetrics(lines, []).usualBodyHeight).toBe(10);
  });

  it('measures vertical gaps within lanes instead of between parallel columns', () => {
    const lines = reconstructLines([
      piece('Left one', 50, 100, 10),
      piece('Left two', 50, 120, 10),
      piece('Right one', 300, 105, 10),
      piece('Right two', 300, 125, 10)
    ], []);

    expect(measurePageMetrics(lines, []).usualVerticalGap).toBe(10);
  });

  it('provides deterministic sparse-page fallbacks', () => {
    const lines = reconstructLines([piece('Only line', 72, 100, 10)], []);
    const metrics = measurePageMetrics(lines, []);

    expect(metrics.usualBodyHeight).toBe(10);
    expect(metrics.usualVerticalGap).toBe(3);
    expect(metrics.activeContentBox).toEqual({ x: 72, y: 100, width: 45, height: 10 });
    expect(metrics.verticalGutters).toEqual([]);
    expect(metrics.horizontalBands).toEqual([]);
  });

  it('clusters repeated edges, row baselines, heights, and styles', () => {
    const lines = reconstructLines([
      piece('Left one', 50, 100, 10, true),
      piece('Right one', 300, 100, 10),
      piece('Left two', 51, 120, 10, true),
      piece('Right two', 301, 120, 10)
    ], []);
    const metrics = measurePageMetrics(lines, []);

    expect(metrics.leftEdges.slice(0, 2)).toEqual([
      { value: 50.5, count: 2, share: 0.5 },
      { value: 300.5, count: 2, share: 0.5 }
    ]);
    expect(metrics.rowBaselines.slice(0, 2)).toEqual([
      { value: 105, count: 2, share: 0.5 },
      { value: 125, count: 2, share: 0.5 }
    ]);
    expect(metrics.heightClusters[0]).toEqual({ value: 10, count: 4, share: 1 });
    expect(metrics.styleClusters).toEqual([
      { height: 10, bold: false, italic: false, count: 2, share: 0.5 },
      { height: 10, bold: true, italic: false, count: 2, share: 0.5 }
    ]);
  });

  it('records vertical gutters and horizontal whitespace bands without splitting', () => {
    const lines = reconstructLines([
      piece('Left one', 50, 100, 10),
      piece('Right one', 300, 100, 10),
      piece('Left two', 50, 160, 10),
      piece('Right two', 300, 160, 10)
    ], []);
    const metrics = measurePageMetrics(lines, []);

    expect(metrics.verticalGutters).toContainEqual({
      box: { x: 90, y: 100, width: 210, height: 70 },
      size: 210,
      coverage: 1
    });
    expect(metrics.horizontalBands).toEqual([{
      box: { x: 50, y: 110, width: 295, height: 50 },
      size: 50,
      coverage: 1
    }]);
  });

  it('measures separator coverage against active content', () => {
    const lines = reconstructLines([
      piece('Left', 50, 100, 10),
      piece('Right', 300, 120, 10)
    ], []);
    const metrics = measurePageMetrics(lines, [{
      orientation: 'horizontal',
      box: { x: 50, y: 115, width: 137.5, height: 1 },
      thickness: 1
    }]);

    expect(metrics.separatorCoverage).toEqual([{ separatorIndex: 0, coverage: 0.5 }]);
  });

  it('keeps page metrics independent in a multi-page trace', () => {
    const { trace } = buildPagesWithTrace([
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        pieces: [piece('Page one A', 72, 100, 10), piece('Page one B', 72, 120, 10)],
        marks: [],
        separators: []
      },
      {
        pageNumber: 2,
        width: 612,
        height: 792,
        pieces: [piece('Page two A', 72, 100, 14), piece('Page two B', 72, 130, 14)],
        marks: [],
        separators: []
      }
    ]);

    expect(trace.pages.map((page) => [
      page.metrics.usualBodyHeight,
      page.metrics.usualVerticalGap
    ])).toEqual([[10, 10], [14, 16]]);
  });
});

describe('resolved page layout', () => {
  it('persists confirmed repeated-style sections as final regions', () => {
    const page = layout([
      piece('EXPERIENCE', 50, 200, 15, true),
      piece('Built reliable services.', 50, 240, 10),
      piece('EDUCATION', 50, 320, 15, true),
      piece('Example University', 50, 360, 10)
    ]);

    expect(page.regions.map((region) => region.role)).toEqual(['section', 'section']);
    expect(page.regions.map((region) => region.lines.map((line) => line.text))).toEqual([
      ['EXPERIENCE', 'Built reliable services.'],
      ['EDUCATION', 'Example University']
    ]);
    expect(page.regions.map((region) => region.lines[0]!.heading)).toEqual([true, true]);
  });

  it('persists entry ownership and anchor-first reading order', () => {
    const page = layout([
      piece('EXPERIENCE', 50, 200, 15, true),
      piece('2022 - 2024', 50, 240, 10),
      piece('Backend Engineer', 230, 240, 11, true),
      piece('Built reliable services.', 230, 260, 10),
      piece('2020 - 2022', 50, 300, 10),
      piece('Software Engineer', 230, 300, 11, true),
      piece('Maintained internal tools.', 230, 320, 10),
      piece('SKILLS', 50, 400, 15, true),
      piece('TypeScript', 50, 440, 10)
    ]);

    const experience = page.regions.find(
      (region) => region.role === 'section' && region.lines[0]?.text === 'EXPERIENCE'
    );
    const entries = page.regions.filter((region) => region.role === 'entry');

    expect(experience).toBeDefined();
    expect(entries).toHaveLength(2);
    expect(entries.every((region) => region.parentIndex === experience!.index)).toBe(true);
    expect(entries[0]!.lines.map((line) => line.text)).toEqual([
      'Backend Engineer',
      '2022 - 2024',
      'Built reliable services.'
    ]);
  });

  it('keeps every reconstructed line in exactly one final region', () => {
    const pieces = [
      piece('Sample Candidate', 50, 40, 24, true),
      piece('EXPERIENCE', 50, 100, 15, true),
      piece('Built reliable services.', 50, 140, 10),
      piece('EDUCATION', 50, 220, 15, true),
      piece('Example University', 50, 260, 10)
    ];
    const page = layout(pieces);
    const stored = page.regions.flatMap((region) => region.lines);

    expect(stored).toHaveLength(reconstructLines(pieces, []).length);
    expect(new Set(stored.map((line) => line.order)).size).toBe(stored.length);
    expect(stored.map((line) => line.order)).toEqual(
      Array.from({ length: stored.length }, (_, index) => index + 1)
    );
    expect(page.regions[0]).toMatchObject({
      role: 'independent',
      parentIndex: null
    });
  });

  it('does not retain legacy layout actions in persisted lines', () => {
    const page = layout([
      piece('EXPERIENCE', 50, 100, 15, true),
      piece('Built reliable services.', 50, 140, 10),
      piece('EDUCATION', 50, 220, 15, true),
      piece('Example University', 50, 260, 10)
    ]);

    for (const line of page.regions.flatMap((region) => region.lines)) {
      expect(line).not.toHaveProperty('layoutAction');
    }
  });
});
