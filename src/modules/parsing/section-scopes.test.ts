import { describe, expect, it } from 'vitest';
import { generateBoundaryCandidates } from './boundary-candidates.js';
import { measurePageMetrics, type LayoutLine } from './layout.js';
import { generateLayoutZoneCandidates } from './macro-layout.js';
import { establishSectionScopes } from './section-scopes.js';
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

function resolve(lines: LayoutLine[], separators: DrawnSeparator[] = []) {
  const metrics = measurePageMetrics(lines, separators);
  const boundaries = generateBoundaryCandidates({
    lines,
    metrics,
    separators,
    pageIndex: 1,
    pageHeight: 800
  });
  const zones = generateLayoutZoneCandidates({
    lines,
    metrics,
    boundaryCandidates: boundaries.lines,
    nonTextBoundaryCandidates: boundaries.nonText
  });
  return {
    zones,
    scopes: establishSectionScopes({
      lines,
      metrics,
      boundaryCandidates: boundaries.lines,
      nonTextBoundaryCandidates: boundaries.nonText,
      layoutZoneCandidates: zones
    })
  };
}

function separator(y: number): DrawnSeparator {
  return {
    orientation: 'horizontal',
    box: { x: 50, y, width: 470, height: 1 },
    thickness: 1
  };
}

describe('section scopes', () => {
  it('establishes a recognized section before competing entry evidence', () => {
    const lines = [
      line('EDUCATION', 40, 100, 90, 10, true),
      line('University | 2020-2024', 160, 100, 170, 10, true),
      line('Bachelor of Engineering', 160, 120, 180)
    ];
    const { scopes } = resolve(lines);

    expect(scopes.find((scope) => scope.headingLineIndex === 0)).toMatchObject({
      status: 'confirmed'
    });
  });

  it('confirms common same-row headings through established repeated styles', () => {
    const lines = [
      line('PROFESSIONAL SUMMARY', 47, 216, 145, 13, true),
      line('CONTACT', 337, 216, 51, 13, true),
      line('Creative and determined content strategist.', 47, 241, 248),
      line('Phone: +123-456-7890', 337, 241, 93),
      line('Email: hello@example.com', 337, 255, 130)
    ];
    const { scopes } = resolve(lines);

    expect(scopes.find((scope) => scope.headingLineIndex === 0)).toMatchObject({
      status: 'confirmed',
      mode: 'lane-local'
    });
    expect(scopes.find((scope) => scope.headingLineIndex === 1)).toMatchObject({
      status: 'confirmed',
      mode: 'lane-local'
    });
  });

  it('keeps one section scope across a provisional vertical gutter', () => {
    const lines = [
      line('EXPERIENCE', 50, 100, 110, 15, true),
      line('2022 - Present', 50, 140, 90, 10, true),
      line('Example Company', 50, 160, 100),
      line('Backend Engineer', 230, 140, 170, 11, true),
      line('Built reliable services.', 230, 165, 290),
      line('SKILLS', 50, 230, 60, 15, true),
      line('TypeScript', 50, 270, 90)
    ];
    const { scopes, zones } = resolve(lines, [separator(122), separator(252)]);
    const scope = scopes.find((candidate) => candidate.headingLineIndex === 0);

    expect(
      zones.some((candidate) => candidate.boundaryBox?.height === candidate.box.height)
    ).toBe(true);
    expect(scope).toMatchObject({ status: 'confirmed', mode: 'cross-lane' });
    expect(scope!.lineIndexes).toEqual([0, 1, 2, 3, 4]);
    expect(scope!.reasons).toContain('provisional vertical zones do not limit this scope');
  });

  it('ends a scope at the next compatible confirmed section', () => {
    const lines = [
      line('EXPERIENCE', 50, 100, 110, 15, true),
      line('Built reliable services.', 50, 145, 400),
      line('EDUCATION', 50, 220, 110, 15, true),
      line('Example University', 50, 260, 180)
    ];
    const { scopes } = resolve(lines, [separator(122), separator(242)]);

    expect(scopes.find((scope) => scope.headingLineIndex === 0)?.lineIndexes).toEqual([0, 1]);
    expect(scopes.find((scope) => scope.headingLineIndex === 2)?.lineIndexes).toEqual([2, 3]);
  });

  it('confirms independent parallel headings as lane-local scopes', () => {
    const lines = [
      line('PROJECTS', 40, 80, 220, 14, true),
      line('Project Alpha', 40, 115, 220, 10, true),
      line('Built an internal platform.', 40, 145, 220),
      line('EDUCATION', 340, 95, 220, 14, true),
      line('Example University', 340, 130, 220, 10, true),
      line('Computer Science degree.', 340, 160, 220)
    ];
    const { scopes, zones } = resolve(lines);
    const projects = scopes.find((scope) => scope.headingLineIndex === 0);
    const education = scopes.find((scope) => scope.headingLineIndex === 3);

    expect(zones.some((candidate) => candidate.kind === 'parallel-columns')).toBe(true);
    expect(projects).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(education).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(projects!.lineIndexes).toEqual([0, 1, 2]);
    expect(education!.lineIndexes).toEqual([3, 4, 5]);
  });

  it('keeps competing reference names as provisional cells', () => {
    const lines = [
      line('Aarya Agarwal', 50, 100, 100, 12, true),
      line('Phone: 123-456-7890', 170, 100, 120),
      line('CEO of Example Company', 50, 125, 130),
      line('Sharin Varma', 330, 100, 90, 12, true),
      line('Phone: 987-654-3210', 440, 100, 120),
      line('HRD of Example Company', 330, 125, 140)
    ];
    const { scopes } = resolve(lines);
    const names = scopes.filter((scope) => [0, 3].includes(scope.headingLineIndex));

    expect(names).toHaveLength(2);
    expect(names.every((scope) => scope.status === 'provisional')).toBe(true);
    expect(names.every((scope) => scope.mode === 'provisional-cell')).toBe(true);
    expect(names[0]!.lineIndexes).toEqual([0, 1, 2]);
    expect(names[1]!.lineIndexes).toEqual([3, 4, 5]);
  });

  it('confirms strong same-row section peers and ends the preceding section', () => {
    const lines = [
      line('WORK EXPERIENCE', 48, 344, 104, 13, true),
      line('Content Strategist | 2037-2040', 48, 368, 125, 10, true),
      line('The Brand Marketing Group', 48, 384, 111),
      line('Created and executed data-driven content projects.', 65, 400, 300),
      line('AWARDS AND CERTIFICATION', 47, 626, 160, 13, true),
      line('ACADEMIC HISTORY', 337, 625, 108, 13, true),
      line('Employee Excellence (2036)', 47, 648, 116, 10, true),
      line('Liberty State University | 2031-2035', 337, 649, 147, 10, true),
      line('Marketing Solutions Agency', 47, 665, 112),
      line('Bachelor of Arts in Marketing Communication', 337, 665, 182),
      line('GPA 3.9', 354, 682, 33)
    ];
    const { scopes } = resolve(lines, [separator(603)]);
    const work = scopes.find((scope) => scope.headingLineIndex === 0);
    const awards = scopes.find((scope) => scope.headingLineIndex === 4);
    const academic = scopes.find((scope) => scope.headingLineIndex === 5);

    expect(work).toMatchObject({ status: 'confirmed', mode: 'cross-lane' });
    expect(work!.lineIndexes).toEqual([0, 1, 2, 3]);
    expect(awards).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(academic).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(awards!.lineIndexes).toEqual([4, 6, 8]);
    expect(academic!.lineIndexes).toEqual([5, 7, 9, 10]);
  });

  it('does not confirm ordinary compact metadata as a standalone section', () => {
    const lines = [
      line('123 Anywhere Street, Any City', 180, 80, 190, 12),
      line('EXPERIENCE', 50, 140, 110, 15, true),
      line('Built reliable services.', 50, 180, 400)
    ];
    const { scopes } = resolve(lines, [separator(110), separator(162)]);

    expect(
      scopes.find((scope) => scope.headingLineIndex === 0)?.status
    ).not.toBe('confirmed');
  });

  it('returns no scopes for an empty page', () => {
    expect(resolve([]).scopes).toEqual([]);
  });

  it('guarantees disjoint confirmed ownership across bounded parallel scopes', () => {
    const lines = [
      line('EXPERIENCE', 40, 100, 100, 14, true),
      line('Built reliable services.', 40, 140, 250),
      line('EDUCATION', 350, 100, 100, 14, true),
      line('Example University', 350, 140, 180, 10, true),
      line('SKILLS', 40, 500, 60, 14, true),
      line('TypeScript', 40, 540, 80)
    ];
    const vertical: DrawnSeparator = {
      orientation: 'vertical',
      box: { x: 320, y: 80, width: 1, height: 300 },
      thickness: 1
    };
    const { scopes } = resolve(lines, [vertical, separator(520)]);
    const owners = new Map<number, number>();

    for (const section of scopes.filter((candidate) => candidate.status === 'confirmed')) {
      for (const lineIndex of section.lineIndexes) {
        expect(owners.has(lineIndex), `line ${lineIndex + 1} has one confirmed owner`).toBe(false);
        owners.set(lineIndex, section.headingLineIndex);
      }
    }

    expect(scopes.find((candidate) => candidate.headingLineIndex === 0)?.lineIndexes).toEqual([0, 1]);
    expect(scopes.find((candidate) => candidate.headingLineIndex === 2)?.lineIndexes).toEqual([2, 3]);
    expect(scopes.find((candidate) => candidate.headingLineIndex === 4)?.lineIndexes).toEqual([4, 5]);
  });

  it('starts a cross-lane layout band after page-wide whitespace without a drawn rule', () => {
    const lines = [
      line('TESTIMONIALS', 40, 100, 105, 14, true),
      line('AWARDS', 415, 100, 70, 14, true),
      line('A regulated assessment mechanism.', 40, 140, 230),
      line('Employee Excellence', 415, 140, 120, 10, true),
      line('Award details continue here.', 415, 165, 145),
      line('SKILLS', 40, 300, 60, 14, true),
      line('Time management', 55, 340, 95),
      line('Project management', 190, 340, 105),
      line('Analytics', 345, 340, 50),
      line('Problem solving', 455, 340, 80)
    ];
    const { scopes } = resolve(lines);
    const awards = scopes.find((candidate) => candidate.headingLineIndex === 1);
    const skills = scopes.find((candidate) => candidate.headingLineIndex === 5);

    expect(awards).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(awards!.lineIndexes).toEqual([1, 3, 4]);
    expect(skills).toMatchObject({ status: 'confirmed', mode: 'cross-lane' });
    expect(skills!.lineIndexes).toEqual([5, 6, 7, 8, 9]);
    expect(skills!.reasons).toContain('page-wide whitespace starts a new layout band');
  });
});
