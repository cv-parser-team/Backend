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

  it('derives lane-local scopes without macro layout hypotheses', () => {
    const lines = [
      line('PROJECTS', 40, 80, 220, 14, true),
      line('Project Alpha', 40, 115, 220, 10, true),
      line('Built an internal platform.', 40, 145, 220),
      line('EDUCATION', 340, 95, 220, 14, true),
      line('Example University', 340, 130, 220, 10, true),
      line('Computer Science degree.', 340, 160, 220)
    ];
    const metrics = measurePageMetrics(lines, []);
    const boundaries = generateBoundaryCandidates({
      lines,
      metrics,
      separators: [],
      pageIndex: 1,
      pageHeight: 800
    });
    const scopes = establishSectionScopes({
      lines,
      metrics,
      boundaryCandidates: boundaries.lines,
      nonTextBoundaryCandidates: boundaries.nonText,
      layoutZoneCandidates: []
    });

    expect(scopes.find((scope) => scope.headingLineIndex === 0)).toMatchObject({
      status: 'confirmed',
      mode: 'lane-local',
      lineIndexes: [0, 1, 2]
    });
    expect(scopes.find((scope) => scope.headingLineIndex === 3)).toMatchObject({
      status: 'confirmed',
      mode: 'lane-local',
      lineIndexes: [3, 4, 5]
    });
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

  it('keeps repeated same-row work-entry headings with their own lane content', () => {
    const lines = [
      line('WORK EXPERIENCE', 48, 542, 244, 20, true),
      line('Assistant Manager', 48, 595, 109, 12, true),
      line('Assistant Manager', 318, 595, 109, 12, true),
      line('Fauget Company, 2019 - Now', 48, 612, 142, 10.5),
      line('Fauget Company, 2017 - 2018', 318, 612, 147, 10.5),
      line('Comprehensive administrative assistance.', 48, 630, 198),
      line('Comprehensive administrative assistance.', 318, 630, 198),
      line('Administrative Assistant', 48, 706, 144, 12, true),
      line('Administrative Assistant', 318, 706, 144, 12, true),
      line('Fauget Company, 2016 - 2017', 48, 723, 147, 10.5),
      line('Fauget Company, 2016 - 2017', 318, 723, 147, 10.5),
      line('Customer Reception. Switchboard management.', 48, 743, 217),
      line('Customer Reception. Switchboard management.', 318, 743, 217)
    ];
    const { scopes } = resolve(lines, [separator(506)]);
    const leftAssistant = scopes.find((scope) => scope.headingLineIndex === 7);
    const rightAssistant = scopes.find((scope) => scope.headingLineIndex === 8);

    expect(leftAssistant).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(rightAssistant).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(leftAssistant!.lineIndexes).toEqual([7, 9, 11]);
    expect(rightAssistant!.lineIndexes).toEqual([8, 10, 12]);
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

  it('rejects a document title even with full-width section support', () => {
    const lines = [
      line('SAMPLE CANDIDATE', 100, 30, 300, 24, true),
      line('Professional Accountant', 100, 70, 180, 12, true),
      line('Supporting profile content.', 100, 100, 300)
    ];
    const metrics = measurePageMetrics(lines, []);
    const boundaries = generateBoundaryCandidates({
      lines,
      metrics,
      separators: [],
      pageIndex: 0,
      pageHeight: 800
    });
    boundaries.lines[0] = {
      ...boundaries.lines[0]!,
      header: { score: 1, reasons: ['within the first-page title area'] },
      section: { score: 1, reasons: ['standalone full-width section hypothesis'] }
    };
    const scopes = establishSectionScopes({
      lines,
      metrics,
      boundaryCandidates: boundaries.lines,
      nonTextBoundaryCandidates: boundaries.nonText,
      layoutZoneCandidates: [{
        kind: 'full-width-section',
        box: { x: 100, y: 30, width: 300, height: 80 },
        boundaryBox: null,
        confidence: 1,
        reasons: [],
        participatingLineIndexes: [0, 1, 2],
        parts: [{
          label: 'full-width-section',
          box: { x: 100, y: 30, width: 300, height: 80 },
          lineIndexes: [0, 1, 2]
        }]
      }]
    });

    expect(scopes.find((scope) => scope.headingLineIndex === 0)).toBeUndefined();
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

  it('preserves asynchronous section continuations in established lanes', () => {
    const lines = [
      line('MY CONTACT', 60, 75, 90, 15, true),
      line('PROFESSIONAL EXPERIENCE', 285, 75, 185, 15, true),
      line('hello@example.com', 80, 115, 125),
      line('First experience paragraph.', 302, 115, 205),
      line('Second experience paragraph.', 302, 160, 215),
      line('ABOUT ME', 60, 224, 75, 15, true),
      line('Experience continuation.', 302, 233, 190),
      line('About summary line one.', 60, 262, 145),
      line('Experience continuation two.', 302, 270, 210),
      line('About summary line two.', 60, 303, 145),
      line('Experience continuation three.', 302, 310, 220),
      line('About summary final line.', 60, 357, 150),
      line('SKILLS', 285, 355, 60, 15, true),
      line('Skill details line one.', 285, 393, 200),
      line('EDUCATION', 63, 399, 120, 15, true),
      line('Skill details line two.', 285, 420, 210),
      line('First University', 75, 439, 120, 10, true),
      line('First degree details.', 75, 453, 110),
      line('Second College', 75, 490, 110, 10, true),
      line('Second degree details.', 75, 504, 115),
      line('ACHIEVEMENTS', 285, 540, 115, 15, true),
      line('Third School', 75, 547, 105, 10, true),
      line('Third degree details.', 75, 561, 110),
      line('Achievement details.', 285, 578, 205)
    ];
    const { scopes } = resolve(lines);
    const experience = scopes.find((scope) => scope.headingLineIndex === 1);
    const about = scopes.find((scope) => scope.headingLineIndex === 5);
    const skills = scopes.find((scope) => scope.headingLineIndex === 12);
    const education = scopes.find((scope) => scope.headingLineIndex === 14);
    const achievements = scopes.find((scope) => scope.headingLineIndex === 20);

    expect(experience).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(experience!.lineIndexes).toEqual([1, 3, 4, 6, 8, 10]);
    expect(about).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(about!.lineIndexes).toEqual([5, 7, 9, 11]);
    expect(skills).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(skills!.lineIndexes).toEqual([12, 13, 15]);
    expect(education).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(education!.lineIndexes).toEqual([14, 16, 17, 18, 19, 21, 22]);
    expect(achievements).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(achievements!.lineIndexes).toEqual([20, 23]);
  });

  it('does not promote a sidebar heading over an active opposite-lane section', () => {
    const lines = [
      line('CONTACT', 60, 80, 75, 15, true),
      line('hello@example.com', 75, 115, 125),
      line('SUMMARY', 285, 80, 85, 15, true),
      line('Profile details.', 285, 115, 180),
      line('EXPERIENCE', 285, 300, 110, 15, true),
      line('First experience details.', 285, 340, 220),
      line('LANGUAGE', 60, 500, 85, 15, true),
      line('Experience continuation.', 285, 510, 220),
      line('English', 75, 550, 55),
      line('Experience continuation two.', 285, 550, 220),
      line('Spanish', 75, 580, 55),
      line('Experience continuation three.', 285, 580, 230)
    ];
    const vertical: DrawnSeparator = {
      orientation: 'vertical',
      box: { x: 240, y: 60, width: 1, height: 540 },
      thickness: 1
    };
    const { scopes } = resolve(lines, [separator(480), vertical]);
    const experience = scopes.find((scope) => scope.headingLineIndex === 4);
    const language = scopes.find((scope) => scope.headingLineIndex === 6);

    expect(language).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(language!.lineIndexes).toEqual([6, 8, 10]);
    expect(language!.reasons).toContain('active section continues in the opposite lane');
    expect(experience).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(experience!.lineIndexes).toEqual([4, 5, 7, 9, 11]);
  });

  it('keeps a long lane-local section wider than later reference cards', () => {
    const lines = [
      line('CONTACT', 63, 237, 67, 12, true),
      line('ABOUT ME', 282, 237, 71, 12, true),
      line('hello@example.com', 63, 270, 131),
      line('Profile summary spans the main content lane.', 250, 269, 295),
      line('EDUCATION', 63, 345, 82, 12, true),
      line('EXPERIENCE', 282, 354, 84, 12, true),
      line('Borcelle University', 39, 379, 86, 10, true),
      line('Product Design Manager', 273, 389, 128),
      line('Bachelor of Business Management', 39, 396, 148),
      line('Arowwai Industries', 273, 402, 89, 9),
      line('2016 - 2020', 508, 403, 45, 8),
      line('First wide experience description.', 273, 418, 280, 8),
      line('Marketing Manager', 273, 472, 101),
      line('Arowwai Industries', 273, 485, 89, 9),
      line('2019 - 2020', 508, 486, 45, 8),
      line('Second wide experience description.', 273, 500, 280, 8),
      line('SKILLS', 63, 570, 43, 12, true),
      line('Management Skills', 49, 600, 94),
      line('Marketing Manager', 273, 555, 101),
      line('Arowwai Industries', 273, 568, 89, 9),
      line('2017 - 2019', 513, 568, 40, 8),
      line('Third wide experience description.', 273, 583, 280, 8),
      line('Leadership', 49, 705, 55),
      line('Marketing Manager', 273, 637, 101),
      line('Arowwai Industries', 273, 650, 89, 9),
      line('2016 - 2017', 513, 651, 40, 8),
      line('Fourth wide experience description.', 273, 665, 280, 8),
      line('REFERENCES', 282, 732, 85, 12, true),
      line('LANGUAGE', 63, 751, 77, 12, true),
      line('Harumi Kobayashi', 250, 762, 115, 12, true),
      line('Bailey Dupont', 434, 762, 86, 12, true),
      line('Wardiere Inc. / CEO', 250, 778, 96),
      line('Wardiere Inc. / CEO', 434, 778, 96)
    ];
    lines[9]!.italic = true;
    lines[13]!.italic = true;
    lines[19]!.italic = true;
    lines[24]!.italic = true;
    const vertical: DrawnSeparator = {
      orientation: 'vertical',
      box: { x: 260, y: 394, width: 1, height: 306 },
      thickness: 1
    };
    const { scopes, zones } = resolve(lines, [vertical]);
    const experience = scopes.find((scope) => scope.headingLineIndex === 5);

    expect(
      zones.some(
        (zone) => zone.kind === 'parallel-columns' || zone.kind === 'sidebar-main'
      )
    ).toBe(true);
    expect(experience).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(experience!.lineIndexes).toEqual([
      5, 7, 9, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 23, 24, 25, 26
    ]);
    expect(experience!.lineIndexes).not.toEqual(expect.arrayContaining([6, 8, 16, 17, 22]));
    expect(experience!.reasons).toContain(
      'persistent macro-layout lane sets horizontal ownership'
    );
    expect(experience!.reasons).toContain(
      'corroborating vertical separator refines the lane edge'
    );
  });

  it('always includes a section heading in its own scope', () => {
    const lines = [
      line('EDUCATION', 40, 80, 200, 15, true),
      line('EXPERIENCE', 350, 80, 150, 15, true),
      line('Education details.', 40, 120, 180),
      line('Experience details.', 350, 120, 160),
      line('ABOUT ME', 100, 200, 50, 15, true),
      line('SKILLS', 350, 200, 70, 15, true),
      line('Profile details.', 100, 240, 140),
      line('Skill details.', 350, 240, 140)
    ];
    const { scopes } = resolve(lines);
    const about = scopes.find((scope) => scope.headingLineIndex === 4);

    expect(about).toMatchObject({ status: 'confirmed', mode: 'lane-local' });
    expect(about!.lineIndexes).toContain(about!.headingLineIndex);
  });
});
