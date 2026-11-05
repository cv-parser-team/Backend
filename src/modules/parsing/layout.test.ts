import { describe, expect, it } from 'vitest';
import { buildPages } from './layout.js';
import { ParsedPage, TextPiece } from './parsing.types.js';

// Each layout is written as positioned text pieces, so the expected regions
// are exact and no PDF is needed. Widths follow a 12 pt font, about 6 points
// per character.
function piece(text: string, x: number, y: number, size = 12, bold = false): TextPiece {
  return { text, box: { x, y, width: text.length * size * 0.5, height: size }, bold, italic: false, links: [] };
}

function column(x: number, startY: number, texts: string[], step = 20): TextPiece[] {
  return texts.map((text, index) => piece(text, x, startY + index * step));
}

function layout(pieces: TextPiece[]): ParsedPage {
  return buildPages([{ pageNumber: 1, width: 612, height: 792, pieces, marks: [] }])[0]!;
}

// Checks that no line is lost or duplicated and that every line sits in its
// expected region, in reading order.
function expectRegions(page: ParsedPage, expected: string[][]): void {
  const actual = page.regions.map((region) => region.lines.map((line) => line.text));
  const actualLines = actual.flat();
  const expectedLines = expected.flat();

  expect([...actualLines].sort(), 'no line lost or duplicated').toEqual([...expectedLines].sort());
  expect(actual, 'every line in its expected region').toEqual(expected);
}

describe('layout regions', () => {
  it('keeps a one-column page as one region', () => {
    const lines = [
      'Sample Candidate',
      'Backend Developer',
      'Experience',
      'Backend Developer at Example Corp',
      'Built REST APIs and services for the shipping system.',
      'Education',
      'BSc Computer Science, Example University'
    ];
    expectRegions(layout(column(72, 100, lines)), [lines]);
  });

  // Real columns rarely share rows line by line, so their lines start at
  // different heights and spacings.
  it('reads two columns one at a time', () => {
    const left = ['Skills', 'Python', 'Docker', 'PostgreSQL', 'Linux'];
    const right = [
      'Experience',
      'Backend Developer',
      'Example Corp, 2021 - 2023',
      'Built REST APIs and services.',
      'Improved query performance.'
    ];
    expectRegions(layout([...column(50, 100, left), ...column(300, 112, right, 24)]), [left, right]);
  });

  it('reads three columns one at a time', () => {
    const first = ['Contact', 'Amman', 'sample@example.com'];
    const second = ['Skills', 'Python', 'Docker'];
    const third = ['Languages', 'English', 'Arabic'];
    expectRegions(
      layout([
        ...column(40, 100, first),
        ...column(240, 110, second, 24),
        ...column(440, 92, third, 17)
      ]),
      [first, second, third]
    );
  });

  it('separates a narrow sidebar from the main column', () => {
    const sidebar = ['Contact', 'Amman', 'Skills', 'Python', 'Docker', 'SQL', 'Languages', 'English'];
    const main = [
      'Sample Candidate',
      'Backend Developer with five years of experience',
      'Experience',
      'Backend Developer at Example Corp, 2021 - 2023',
      'Built REST APIs and services for the shipping system.',
      'Software Intern at Sample Labs, 2019 - 2020',
      'Education',
      'BSc Computer Science, Example University'
    ];
    expectRegions(layout([...column(30, 80, sidebar), ...column(160, 92, main, 24)]), [sidebar, main]);
  });

  it('keeps two wide columns that share every row as one region', () => {
    // Text that lines up row by row on both sides may be a two-column table,
    // so it is not split; rows are read left to right.
    const pieces = [
      ...column(50, 100, ['Backend Developer', 'Software Intern', 'Teaching Assistant']),
      ...column(300, 100, ['Example Corp, Amman', 'Sample Labs, Gaza', 'Example University'])
    ];
    expectRegions(layout(pieces), [
      [
        'Backend Developer',
        'Example Corp, Amman',
        'Software Intern',
        'Sample Labs, Gaza',
        'Teaching Assistant',
        'Example University'
      ]
    ]);
  });

  it('keeps a table in one region, including a cell that spans two lines', () => {
    const pieces = [
      piece('Work History', 72, 80),
      piece('Position', 72, 110),
      piece('Company', 260, 110),
      piece('Period', 440, 110),
      piece('Senior Backend', 72, 130),
      piece('ABC Company', 260, 130),
      piece('2021 - 2023', 440, 130),
      piece('Developer', 72, 144),
      piece('Intern', 72, 170),
      piece('XYZ Ltd', 260, 170),
      piece('2020 - 2021', 440, 170)
    ];
    expectRegions(layout(pieces), [
      [
        'Work History',
        'Position',
        'Company',
        'Period',
        'Senior Backend',
        'ABC Company',
        '2021 - 2023',
        'Developer',
        'Intern',
        'XYZ Ltd',
        '2020 - 2021'
      ]
    ]);
  });

  it('keeps right-aligned dates with their entries', () => {
    const pieces = [
      piece('Backend Developer', 72, 100),
      piece('2021 - 2023', 470, 100),
      piece('Example Corp', 72, 116),
      piece('Built REST APIs for the shipping system.', 72, 132),
      piece('Software Intern', 72, 170),
      piece('2019 - 2020', 470, 170),
      piece('Sample Labs', 72, 186)
    ];
    expectRegions(layout(pieces), [
      [
        'Backend Developer',
        '2021 - 2023',
        'Example Corp',
        'Built REST APIs for the shipping system.',
        'Software Intern',
        '2019 - 2020',
        'Sample Labs'
      ]
    ]);
  });

  it('splits short skills beside long paragraphs', () => {
    const skills = ['Python', 'Docker', 'SQL', 'Git'];
    const paragraphs = [
      'Built REST APIs and background services for the shipping',
      'system, including tracking, notifications, and reports.',
      'Improved database queries and reduced response times',
      'across the most used endpoints of the platform.',
      'Mentored two junior developers and reviewed their code',
      'every week as part of the backend team.'
    ];
    expectRegions(
      layout([...column(50, 100, skills), ...column(200, 112, paragraphs, 15)]),
      [skills, paragraphs]
    );
  });

  it('keeps earlier splits intact when regions are split again', () => {
    const header = ['Sample Candidate', 'Backend Developer, Amman'];
    const left = ['Skills', 'Python', 'Docker', 'Languages', 'English'];
    const experience = [
      'Experience',
      'Backend Developer at Example Corp',
      'Built REST APIs and services.'
    ];
    const projects = ['Projects', 'Shop API with Laravel', 'Blog CMS with roles'];
    const pieces = [
      piece(header[0]!, 230, 60, 16),
      piece(header[1]!, 220, 84),
      ...column(40, 130, left),
      piece(experience[0]!, 220, 130, 14),
      ...column(220, 152, experience.slice(1), 16),
      piece(projects[0]!, 220, 220, 14),
      ...column(220, 242, projects.slice(1), 16)
    ];
    expectRegions(layout(pieces), [header, left, experience, projects]);
  });
});

// Sections that sit side by side above their columns belong to those columns,
// even when their lines share rows. Only text that crosses the gap between
// columns, or sits above one column alone, is read before them.
describe('areas above columns', () => {
  const sidebar = ['+1 555 0100', 'sample@example.com', 'Springfield', 'Amman, Jordan'];
  const main = [
    'Backend developer with five years of',
    'experience building REST APIs and',
    'services for logistics and retail.',
    'Backend Developer at Example Corp',
    'Built tracking and billing services.',
    'Software Intern at Sample Labs',
    'Wrote integration tests for the API.'
  ];

  it.each([
    ['left', 40, 220],
    ['right', 420, 40]
  ])('keeps each heading of a heading row with its column when the sidebar is on the %s', (_side, sidebarX, mainX) => {
    const page = layout([
      piece('Contact', sidebarX, 120, 14),
      piece('About Me', mainX, 120, 14),
      ...column(sidebarX, 151.5, sidebar, 30),
      ...column(mainX, 144, main, 15)
    ]);
    const sidebarRegion = ['Contact', ...sidebar];
    const mainRegion = ['About Me', ...main];

    expectRegions(page, sidebarX < mainX ? [sidebarRegion, mainRegion] : [mainRegion, sidebarRegion]);
  });

  it('keeps each heading of a heading row with its column across three columns', () => {
    const first = ['+1 555 0100', 'sample@example.com', 'Springfield'];
    const second = ['Python', 'Docker', 'PostgreSQL', 'Linux'];
    const third = ['English', 'German', 'French'];
    const page = layout([
      piece('Contact', 40, 90, 14),
      piece('Skills', 240, 90, 14),
      piece('Languages', 440, 90, 14),
      ...column(40, 151.5, first, 30),
      ...column(240, 144, second, 15),
      ...column(440, 166.5, third, 30)
    ]);

    expectRegions(page, [
      ['Contact', ...first],
      ['Skills', ...second],
      ['Languages', ...third]
    ]);
  });

  it('keeps side-by-side sections whose lines share rows with the columns below them', () => {
    const contact = ['+1 555 0100', 'sample@example.com', 'Springfield'];
    const profile = [
      'Backend developer with five years of',
      'experience in REST APIs and cloud',
      'services for logistics companies.'
    ];
    const skills = ['Python', 'Docker', 'SQL'];
    const experience = [
      'Backend Developer at Example Corp',
      '2021 - 2023',
      'Built tracking and billing services.',
      'Software Intern at Sample Labs',
      '2019 - 2020'
    ];
    const page = layout([
      piece('Contact', 40, 120, 14),
      piece('Profile', 220, 120, 14),
      ...column(40, 140, contact, 16),
      ...column(220, 140, profile, 16),
      piece('Skills', 40, 220, 14),
      piece('Experience', 220, 220, 14),
      ...column(40, 251.5, skills, 30),
      ...column(220, 244, experience, 15)
    ]);

    expectRegions(page, [
      ['Contact', ...contact],
      ['Skills', ...skills],
      ['Profile', ...profile],
      ['Experience', ...experience]
    ]);
  });

  it('reads a header and a summary that cross the column gap before the columns', () => {
    const skills = ['Skills', 'Python', 'Docker'];
    const experience = [
      'Experience',
      'Backend Developer at Example Corp',
      'Built tracking and billing services.',
      'Software Intern at Sample Labs',
      'Wrote integration tests for the API.'
    ];
    const summary = [
      'Backend developer with five years of experience building APIs and services',
      'for logistics and retail companies across the region.'
    ];
    const page = layout([
      piece('Sample Candidate', 150, 40, 20),
      piece('sample@example.com | +1 555 0100 | Springfield', 100, 70),
      piece('Summary', 40, 110, 14),
      ...column(40, 130, summary, 15),
      ...column(40, 207.5, skills, 30),
      ...column(220, 200, experience, 15)
    ]);

    expectRegions(page, [
      ['Sample Candidate', 'sample@example.com | +1 555 0100 | Springfield'],
      ['Summary', ...summary],
      skills,
      experience
    ]);
  });
});

describe('headings and sections', () => {
  const lines = (texts: string[], startY: number, size = 12, bold = false): TextPiece[] =>
    texts.map((text, index) => piece(text, 72, startY + index * 16, size, bold));

  it('marks larger lines as headings and starts a new section after them', () => {
    const page = layout([
      piece('Experience', 72, 80, 14),
      ...lines(['Backend Developer at Example Corp', 'Built REST APIs and services.'], 100),
      piece('Education', 72, 160, 14),
      ...lines(['BSc Computer Science, Example University'], 180)
    ]);

    expectRegions(page, [
      ['Experience', 'Backend Developer at Example Corp', 'Built REST APIs and services.'],
      ['Education', 'BSc Computer Science, Example University']
    ]);
    expect(page.regions.map((region) => region.lines[0]!.heading)).toEqual([true, true]);
    expect(page.regions[0]!.lines[1]!.heading).toBe(false);
  });

  it('does not start a section at a bold body-size line', () => {
    // Bold body-size text is often a job title, so the job stays together.
    const page = layout([
      piece('Backend Developer', 72, 100, 12, true),
      ...lines(['Example Corp, 2021 - 2023', 'Built REST APIs and services.'], 116),
      piece('Software Intern', 72, 180, 12, true),
      ...lines(['Sample Labs, 2019 - 2020'], 196)
    ]);

    expect(page.regions).toHaveLength(1);
    expect(page.regions[0]!.lines.filter((line) => line.bold).map((line) => line.text)).toEqual([
      'Backend Developer',
      'Software Intern'
    ]);
    expect(page.regions[0]!.lines.every((line) => !line.heading)).toBe(true);
  });

  it('keeps a multi-line description together', () => {
    const description = [
      'Built REST APIs and background services for the shipping',
      'system, including tracking, notifications, and reports,',
      'and improved query performance across the platform.'
    ];
    expectRegions(layout([piece('Experience', 72, 80, 14), ...lines(description, 100)]), [
      ['Experience', ...description]
    ]);
  });

  it('marks a line bold when most of its characters are bold', () => {
    const page = layout([
      piece('GPA:', 72, 100),
      piece('85.84 out of 100', 100, 100, 12, true),
      piece('Skills:', 72, 120, 12, true),
      piece('Python, Docker, PostgreSQL, Linux', 116, 120)
    ]);

    expect(page.regions[0]!.lines.map((line) => [line.text, line.bold])).toEqual([
      ['GPA: 85.84 out of 100', true],
      ['Skills: Python, Docker, PostgreSQL, Linux', false]
    ]);
  });
});

describe('line building', () => {
  it('keeps one copy of text drawn twice for a shadow effect', () => {
    const page = layout([
      piece('EDUCATION', 72, 100),
      piece('EDUCATION', 72, 101),
      piece('Sample University', 72, 120),
      piece('EDUCATION', 72, 140)
    ]);

    expect(page.regions.flatMap((region) => region.lines.map((line) => line.text))).toEqual([
      'EDUCATION',
      'Sample University',
      'EDUCATION'
    ]);
  });
});

describe('list bullets', () => {
  function layoutWithMarks(pieces: TextPiece[], marks: { x: number; y: number }[]): ParsedPage {
    return buildPages([
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        pieces,
        marks: marks.map(({ x, y }) => ({ x, y, width: 4, height: 4 }))
      }
    ])[0]!;
  }

  it('marks lines that start after a small drawn mark or a bullet character', () => {
    const page = layoutWithMarks(
      [
        piece('Client Acquisition', 90, 100),
        piece('Relationship', 90, 116),
        piece('Management', 90, 132),
        piece('• Problem-Solving', 80, 148),
        piece('Far from the dot', 300, 100)
      ],
      [
        { x: 80, y: 104 },
        { x: 80, y: 120 }
      ]
    );

    expect(page.regions.flatMap((region) => region.lines.map((line) => [line.text, line.bullet]))).toEqual([
      ['Client Acquisition', true],
      ['Far from the dot', false],
      ['Relationship', true],
      ['Management', false],
      ['• Problem-Solving', true]
    ]);
  });

  it('does not mark headings as list items', () => {
    const page = layoutWithMarks(
      [piece('Education', 90, 100, 16), piece('Example University', 90, 124), piece('Computer Science', 90, 140)],
      [{ x: 80, y: 106 }]
    );

    expect(page.regions.flatMap((region) => region.lines.map((line) => line.bullet))).toEqual([false, false, false]);
  });
});
