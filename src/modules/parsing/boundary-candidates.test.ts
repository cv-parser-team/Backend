import { describe, expect, it } from 'vitest';
import { generateBoundaryCandidates } from './boundary-candidates.js';
import { measurePageMetrics, type LayoutLine } from './layout.js';
import type { DrawnSeparator } from './parsing.types.js';

function line(
  text: string,
  x: number,
  y: number,
  height = 10,
  bold = false,
  width = text.length * height * 0.5
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
  return generateBoundaryCandidates({
    lines,
    metrics: measurePageMetrics(lines, separators),
    separators,
    pageIndex,
    pageHeight: 800
  });
}

describe('boundary candidate scoring', () => {
  it('scores a prominent first-page title as a header without committing an action', () => {
    const result = generate([
      line('SAMPLE CANDIDATE', 100, 30, 24, true),
      line('Backend Engineer', 100, 100),
      line('Built reliable systems for customers.', 100, 120)
    ]);

    expect(result.lines[0]!.header.score).toBe(1);
    expect(result.lines[0]!.header.reasons).toContain('within the first-page title area');
    expect(result.lines[0]).not.toHaveProperty('layoutAction');
  });

  it('keeps repeated bold names ambiguous between section and entry roles', () => {
    const result = generate([
      line('Aarya Agarwal', 60, 100, 11, true),
      line('CEO of Example Company', 60, 116, 8),
      line('Sharin Varma', 60, 160, 11, true),
      line('HRD of Example Company', 60, 176, 8)
    ], [], 1);

    expect(result.lines[0]!.section.score).toBeGreaterThan(0.5);
    expect(result.lines[0]!.entry.score).toBeGreaterThan(0.5);
    expect(result.lines[0]!.entry.reasons).toContain('nearby following body text');
  });

  it('scores paragraph-shaped regular text as ordinary content', () => {
    const result = generate([
      line('Summary', 60, 80, 14, true),
      line(
        'Built reliable services for customers across several regions and improved delivery quality.',
        60,
        110,
        10,
        false,
        430
      )
    ]);

    const body = result.lines[1]!;
    expect(body.content.score).toBeGreaterThan(body.section.score);
    expect(body.content.reasons).toContain('sentence or paragraph shape');
  });

  it('gives a spanning separator more evidence than a decorative short rule', () => {
    const lines = [
      line('First section', 50, 80, 10, false, 400),
      line('Second section', 50, 140, 10, false, 400)
    ];
    const separators: DrawnSeparator[] = [
      { orientation: 'horizontal', box: { x: 50, y: 115, width: 400, height: 1 }, thickness: 1 },
      { orientation: 'horizontal', box: { x: 50, y: 125, width: 20, height: 1 }, thickness: 1 }
    ];
    const nonText = generate(lines, separators).nonText.filter(
      (candidate) => candidate.kind === 'separator'
    );

    expect(nonText[0]!.evidence.score).toBeGreaterThan(nonText[1]!.evidence.score);
    expect(nonText[1]!.evidence.score).toBeLessThanOrEqual(0.3);
  });

  it('reduces separator authority for repeated table-like rules', () => {
    const lines = [
      line('Row one', 50, 80, 10, false, 400),
      line('Row two', 50, 160, 10, false, 400)
    ];
    const single: DrawnSeparator = {
      orientation: 'horizontal',
      box: { x: 50, y: 120, width: 400, height: 1 },
      thickness: 1
    };
    const repeated: DrawnSeparator[] = [100, 120, 140].map((y) => ({
      orientation: 'horizontal',
      box: { x: 50, y, width: 400, height: 1 },
      thickness: 1
    }));
    const singleScore = generate(lines, [single]).nonText.find(
      (candidate) => candidate.kind === 'separator'
    )!.evidence.score;
    const repeatedScore = generate(lines, repeated).nonText.find(
      (candidate) => candidate.kind === 'separator'
    )!.evidence.score;

    expect(repeatedScore).toBeLessThan(singleScore);
  });

  it('emits non-text gutter, band, separator, and alignment evidence', () => {
    const lines = [
      line('Left one', 50, 80, 10, false, 40),
      line('Left two', 50, 100, 10, false, 40),
      line('Right one', 300, 160, 10, false, 50),
      line('Right two', 300, 180, 10, false, 50)
    ];
    const separator: DrawnSeparator = {
      orientation: 'horizontal',
      box: { x: 50, y: 135, width: 300, height: 1 },
      thickness: 1
    };
    const kinds = new Set(generate(lines, [separator]).nonText.map((candidate) => candidate.kind));

    expect(kinds).toEqual(new Set([
      'vertical-gutter',
      'horizontal-band',
      'separator',
      'alignment-change'
    ]));
  });

  it('keeps every candidate score normalized', () => {
    const result = generate([
      line('Candidate', 50, 30, 30, true),
      line('2020 - Present', 50, 100, 10, true),
      line('• Leadership', 50, 130)
    ]);
    const scores = result.lines.flatMap((candidate) => [
      candidate.header.score,
      candidate.section.score,
      candidate.entry.score,
      candidate.content.score
    ]).concat(result.nonText.map((candidate) => candidate.evidence.score));

    expect(scores.every((score) => score >= 0 && score <= 1)).toBe(true);
  });
});
