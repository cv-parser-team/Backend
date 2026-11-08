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
  it('normalizes spaced dates and split section headings before classification', () => {
    const result = generate([
      line('PROFESSIONAL', 50, 100, 10, true),
      line('Current role', 250, 100, 10, true),
      line('EXPERIENCE', 50, 113, 10, true),
      line('2 0 2 0 – 2 0 2 3', 420, 140, 10, true)
    ], [], 1);

    expect(result.lines[0]!.section.reasons).toContain('exact common section heading');
    expect(result.lines[0]!.sectionKind).toBe('experience');
    expect(result.lines[2]!.section.reasons).toContain(
      'continues a split common section heading'
    );
    expect(result.lines[2]!.sectionKind).toBe('other');
    expect(result.lines[3]!.section.reasons).toContain('date value reduces heading authority');
  });

  it('classifies only exact education and experience section labels', () => {
    const result = generate([
      line('WORK EXPERIENCE', 50, 100, 13, true),
      line('ACADEMIC HISTORY', 50, 150, 13, true),
      line('Bachelor of Education', 50, 200, 13, true),
      line('SKILLS', 50, 250, 13, true)
    ], [], 1);

    expect(result.lines.map((candidate) => candidate.sectionKind)).toEqual([
      'experience',
      'education',
      'other',
      'other'
    ]);
  });

  it('recognizes normalized common section names without matching substrings', () => {
    const result = generate([
      line('PROFESSIONAL SUMMARY:', 50, 100, 13, true),
      line('Bachelor of Education', 50, 150, 13, true),
      line('Supporting body copy', 50, 180)
    ], [], 1);

    expect(result.lines[0]!.section.reasons).toContain('exact common section heading');
    expect(result.lines[1]!.section.reasons).not.toContain('exact common section heading');
  });

  it.each([
    'KEY SKILLS',
    'PROFESSIONAL SKILLS',
    'SKILLS SUMMARY',
    'TECHNICAL EXPERTISE',
    'TECHNICAL PROFICIENCIES'
  ])('recognizes %s as a common skills section heading', (heading) => {
    const result = generate([
      line(heading, 50, 100, 13, true),
      line('TypeScript, Node.js, PostgreSQL', 50, 140)
    ], [], 1);

    expect(result.lines[0]!.section.reasons).toContain('exact common section heading');
    expect(result.lines[0]!.sectionKind).toBe('other');
  });

  it('uses only established section styles during the repeated-style pass', () => {
    const result = generate([
      line('Aarya Agarwal', 50, 100, 13, true),
      line('CEO of Example Company', 50, 120),
      line('Sharin Varma', 50, 180, 13, true),
      line('HRD of Example Company', 50, 200),
      line('Ordinary supporting copy', 50, 220),
      line('More ordinary supporting copy', 50, 240)
    ], [], 1);

    expect(result.lines[0]!.section.reasons).not.toEqual(
      expect.arrayContaining([expect.stringContaining('established section heading')])
    );
    expect(result.lines[2]!.section.reasons).not.toEqual(
      expect.arrayContaining([expect.stringContaining('established section heading')])
    );
  });

  it('requires matching font style and letter capping for repeated section styles', () => {
    const lines = [
      line('EXPERIENCE', 50, 100, 13, true),
      line('COMMUNITY WORK', 50, 116, 13, true),
      line('Community Projects', 50, 132, 13, true),
      line('REGULAR HEADING', 50, 148, 13, false),
      line('ITALIC HEADING', 50, 164, 13, true),
      line('Supporting body copy one', 250, 200),
      line('Supporting body copy two', 250, 220),
      line('Supporting body copy three', 250, 240),
      line('Supporting body copy four', 250, 260),
      line('Supporting body copy five', 250, 280),
      line('Supporting body copy six', 250, 300)
    ];
    lines[4]!.italic = true;
    const result = generate(lines, [], 1);

    expect(result.lines[1]!.section.reasons).toContain(
      'style matches 1 established section heading in the same lane'
    );
    for (const lineIndex of [2, 3, 4]) {
      expect(result.lines[lineIndex]!.section.reasons).not.toEqual(
        expect.arrayContaining([expect.stringContaining('established section heading')])
      );
    }
  });

  it('uses weak raw repetition to establish styles during the first pass', () => {
    const result = generate([
      line('COMMUNITY WORK', 50, 100, 13, true),
      line('SELECTED TALKS', 50, 120, 13, true),
      line('INDUSTRY EVENTS', 50, 140, 13, true),
      line('MENTORING WORK', 50, 160, 13, true),
      line('OPEN SOURCE WORK', 50, 180, 13, true),
      line('PROFESSIONAL GROUPS', 50, 200, 13, true),
      line('Supporting body copy one', 250, 300),
      line('Supporting body copy two', 250, 320),
      line('Supporting body copy three', 250, 340),
      line('Supporting body copy four', 250, 360),
      line('Supporting body copy five', 250, 380),
      line('Supporting body copy six', 250, 400),
      line('Supporting body copy seven', 250, 420),
      line('Supporting body copy eight', 250, 440),
      line('Supporting body copy nine', 250, 460),
      line('Supporting body copy ten', 250, 480)
    ], [], 1);

    expect(result.lines[0]!.section.reasons).toContain(
      'style matches 5 established section headings in the same lane'
    );
    expect(result.lines[0]!.section.score).toBe(1);
  });

  it('increases repeated established-section evidence up to a 0.45 cap', () => {
    const result = generate([
      line('EXPERIENCE', 50, 100, 13, true),
      line('EDUCATION', 50, 150, 13, true),
      line('SKILLS', 50, 200, 13, true),
      line('PROJECTS', 50, 250, 13, true),
      line('REFERENCES', 50, 300, 13, true),
      line('COMMUNITY WORK', 50, 350, 13, true),
      line('Supporting body copy', 50, 380),
      line('More supporting body copy', 50, 400)
    ], [], 1);
    const customHeading = result.lines[5]!;

    expect(customHeading.section.reasons).toContain(
      'style matches 5 established section headings in the same lane'
    );
    expect(customHeading.section.score).toBe(0.75);
  });

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

  it('does not establish repeated document-title styles as section styles', () => {
    const result = generate([
      line('SAMPLE', 100, 20, 24, true),
      line('CANDIDATE', 100, 48, 24, true),
      line('PROFESSIONAL', 100, 76, 24, true),
      line('ACCOUNTANT', 100, 104, 24, true),
      line('RESUME', 100, 132, 24, true),
      line('Supporting body copy one', 100, 200),
      line('Supporting body copy two', 100, 220),
      line('Supporting body copy three', 100, 240),
      line('Supporting body copy four', 100, 260),
      line('Supporting body copy five', 100, 280),
      line('Supporting body copy six', 100, 300)
    ]);

    for (const candidate of result.lines.slice(0, 5)) {
      expect(candidate.header.score).toBeGreaterThanOrEqual(0.8);
      expect(candidate.section.reasons).not.toEqual(
        expect.arrayContaining([expect.stringContaining('established section heading')])
      );
    }
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

  it('applies separate capped penalties for bullets, dates, and number-dominant lines', () => {
    const bullet = line('LEADERSHIP', 50, 100, 13, true);
    bullet.bullet = true;
    const result = generate([
      bullet,
      line('2020 - 2024', 50, 150, 13, true),
      line('GPA 3.9', 50, 200, 13, true),
      line('Top 10 Achievements', 50, 250, 13, true),
      line('Supporting body copy one', 250, 300),
      line('Supporting body copy two', 250, 320)
    ], [], 1);

    expect(result.lines[0]!.section.reasons).toContain('bullet item reduces heading authority');
    expect(result.lines[1]!.section.reasons).toEqual(expect.arrayContaining([
      'date value reduces heading authority',
      'number-dominant text reduces heading authority'
    ]));
    expect(result.lines[2]!.section.reasons).toContain(
      'number-dominant text reduces heading authority'
    );
    expect(result.lines[3]!.section.reasons).not.toContain(
      'number-dominant text reduces heading authority'
    );
    expect(result.lines[1]!.section.score).toBe(0);
    expect(result.lines[2]!.section.score).toBe(0.05);
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
