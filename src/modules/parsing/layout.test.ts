import { describe, expect, it } from 'vitest';
import { buildPages, reconstructLines } from './layout.js';
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
  return buildPages([
    { pageNumber: 1, width: 612, height: 792, pieces, marks: [], separators: [] }
  ])[0]!;
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

  it('keeps repeated same-row lanes as separate visual lines', () => {
    const lines = reconstructLines([
      piece('Stakeholder', 100, 100, 10),
      piece('Leadership', 168, 100, 10),
      piece('Commercial', 100, 116, 10),
      piece('Forecasting', 168, 116, 10)
    ], []);

    expect(lines.map((line) => line.text)).toEqual([
      'Stakeholder',
      'Leadership',
      'Commercial',
      'Forecasting'
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
    const page = layout(pieces);
    expectRegions(page, [
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
    const page = layout(pieces);
    expectRegions(page, [
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

  it('preserves narrow grid cells when their column starts repeat across rows', () => {
    const pieces = [
      piece('Stakeholder', 100, 100, 10),
      piece('Leadership', 168, 100, 10),
      piece('Commercial', 100, 116, 10),
      piece('Forecasting', 168, 116, 10)
    ];

    expectRegions(layout(pieces), [
      ['Stakeholder', 'Leadership', 'Commercial', 'Forecasting']
    ]);
  });

  it('still joins one-off PDF fragments within prose lines', () => {
    const pieces = [
      piece('Built', 100, 100, 10),
      piece('reliable services.', 130, 100, 10),
      piece('Improved', 100, 116, 10),
      piece('database performance.', 145, 116, 10)
    ];

    expectRegions(layout(pieces), [
      ['Built reliable services.', 'Improved database performance.']
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

  it('splits repeated emphasized entry headings with their dates and bodies', () => {
    const pieces = [
      piece('WORK EXPERIENCE', 72, 70, 16, true),
      piece('Backend Developer', 72, 100, 13, true),
      piece('2021 - Present', 470, 100, 13, true),
      piece('Built APIs for the shipping system.', 72, 118, 10),
      piece('Improved database query performance.', 72, 132, 10),
      piece('Software Intern', 72, 170, 13, true),
      piece('2019 - 2020', 470, 170, 13, true),
      piece('Maintained internal reporting tools.', 72, 188, 10)
    ];

    const page = layout(pieces);
    expectRegions(page, [
      [
        'WORK EXPERIENCE',
        'Backend Developer',
        '2021 - Present',
        'Built APIs for the shipping system.',
        'Improved database query performance.'
      ],
      ['Software Intern', '2019 - 2020', 'Maintained internal reporting tools.']
    ]);
  });

  it('splits repeated larger entry headings when dates are absent', () => {
    const pieces = [
      piece('PROJECTS', 72, 70, 16, true),
      piece('Inventory Platform', 72, 100, 13, true),
      piece('Designed the order management workflow.', 72, 118, 10),
      piece('Reporting Portal', 72, 160, 13, true),
      piece('Built dashboards for operations teams.', 72, 178, 10)
    ];

    expectRegions(layout(pieces), [
      ['PROJECTS', 'Inventory Platform', 'Designed the order management workflow.'],
      ['Reporting Portal', 'Built dashboards for operations teams.']
    ]);
  });

  it('does not split at an isolated emphasized label', () => {
    const pieces = [
      piece('PROFILE', 72, 70, 16, true),
      piece('Product Engineer', 72, 100, 13, true),
      piece('Builds reliable tools for operations teams.', 72, 118, 10),
      piece('Additional profile detail.', 72, 160, 10)
    ];

    expectRegions(layout(pieces), [[
      'PROFILE',
      'Product Engineer',
      'Builds reliable tools for operations teams.',
      'Additional profile detail.'
    ]]);
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

  it('reads synchronized section lanes heading first and then their contents', () => {
    const page = layout([
      piece('EDUCATION', 50, 200, 16, true),
      piece('CONTACT', 400, 200, 16, true),
      // This extends beyond the heading gutter's midpoint but not across the
      // right-hand heading, so it still belongs to the education lane.
      piece('International Sample University | 2020 - 2024', 50, 230, 10),
      piece('+1 555 0100', 400, 230, 10),
      piece('Bachelor of Accounting', 50, 246, 10),
      piece('sample@example.com', 400, 246, 10),
      piece('WORK EXPERIENCE', 50, 320, 16, true),
      piece('SKILLS', 400, 320, 16, true),
      piece('Example Corp | 2024 - Present', 50, 350, 10),
      piece('Auditing', 400, 350, 10),
      piece('Senior Accountant', 50, 366, 11, true),
      piece('Financial Reporting', 400, 366, 10),
      piece('Prepared monthly financial reports.', 50, 382, 10),
      piece('Time Management', 400, 382, 10)
    ]);

    expectRegions(page, [
      ['EDUCATION', 'International Sample University | 2020 - 2024', 'Bachelor of Accounting'],
      [
        'WORK EXPERIENCE',
        'Example Corp | 2024 - Present',
        'Senior Accountant',
        'Prepared monthly financial reports.'
      ],
      ['CONTACT', '+1 555 0100', 'sample@example.com'],
      ['SKILLS', 'Auditing', 'Financial Reporting', 'Time Management']
    ]);
  });

  it('makes equivalent section headings decisive across an existing gutter', () => {
    const page = layout([
      piece('AWARDS', 50, 200, 13, true),
      piece('EDUCATION', 350, 200, 13, true),
      piece('Employee Excellence (2036)', 50, 224, 10, true),
      piece('Liberty State University | 2031-2035', 350, 225, 10, true),
      piece('Marketing Solutions Agency', 50, 241, 10),
      piece('Bachelor of Arts in Marketing', 350, 241, 10),
      piece('Writing Award (2034)', 50, 272, 10, true),
      piece('GPA 3.9', 350, 258, 10),
      piece('Editorial Staff', 50, 289, 10),
      piece('University Marketing Society', 350, 275, 10)
    ]);

    expectRegions(page, [
      [
        'AWARDS',
        'Employee Excellence (2036)',
        'Marketing Solutions Agency'
      ],
      ['Writing Award (2034)', 'Editorial Staff'],
      [
        'EDUCATION',
        'Liberty State University | 2031-2035',
        'Bachelor of Arts in Marketing',
        'GPA 3.9',
        'University Marketing Society'
      ]
    ]);
  });

  it('ends parallel section lanes at a later standalone section heading', () => {
    const page = layout([
      piece('WORK EXPERIENCE', 50, 200, 16, true),
      piece('EDUCATION', 320, 200, 16, true),
      piece('Example Corp | 2020 - Present', 50, 230, 10),
      piece('Sample University | 2016 - 2020', 320, 230, 10),
      piece('Senior Accountant', 50, 246, 11, true),
      piece('Bachelor of Accounting', 320, 246, 11, true),
      piece('Prepared monthly financial reports.', 50, 262, 10),
      piece('Graduated with honors.', 320, 262, 10),
      piece('AWARDS', 50, 330, 16, true),
      piece('01', 50, 365, 14, true),
      piece('Employee of the year', 50, 388, 10),
      piece('02', 240, 365, 14, true),
      piece('Accounting excellence', 240, 388, 10)
    ]);

    expectRegions(page, [
      [
        'WORK EXPERIENCE',
        'Example Corp | 2020 - Present',
        'Senior Accountant',
        'Prepared monthly financial reports.'
      ],
      ['EDUCATION', 'Sample University | 2016 - 2020', 'Bachelor of Accounting', 'Graduated with honors.'],
      ['AWARDS', '01', '02', 'Employee of the year', 'Accounting excellence']
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

  it.each([
    ['left', 50, 220],
    ['right', 430, 50]
  ])(
    'keeps section headings on the %s with bodies in the adjacent column',
    (_side, headingX, bodyX) => {
      const page = layout([
        piece('EXPERIENCE', headingX, 200, 16, true),
        piece('Example Corp', bodyX, 200, 10),
        piece('Backend Developer', bodyX, 216, 10),
        piece('Built billing and reporting services.', bodyX, 232, 10),
        piece('EDUCATION', headingX, 310, 16, true),
        piece('Example University', bodyX, 310, 10),
        piece('BSc Computer Science', bodyX, 326, 10)
      ]);

      expectRegions(page, [
        [
          'EXPERIENCE',
          'Example Corp',
          'Backend Developer',
          'Built billing and reporting services.'
        ],
        ['EDUCATION', 'Example University', 'BSc Computer Science']
      ]);
    }
  );

  it.each([
    ['left', 50, 220],
    ['right', 430, 50]
  ])(
    'keeps entry headings on the %s with bodies in the adjacent column',
    (_side, headingX, bodyX) => {
      const page = layout([
        piece('WORK EXPERIENCE', 50, 180, 16, true),
        piece('Backend Developer', headingX, 220, 11, true),
        piece('Example Corp | 2021 - Present', bodyX, 220, 10),
        piece('Built billing services.', bodyX, 236, 10),
        piece('Software Intern', headingX, 300, 11, true),
        piece('Sample Labs | 2019 - 2020', bodyX, 300, 10),
        piece('Maintained reporting tools.', bodyX, 316, 10)
      ]);

      expectRegions(page, [
        [
          'WORK EXPERIENCE',
          'Backend Developer',
          'Example Corp | 2021 - Present',
          'Built billing services.'
        ],
        ['Software Intern', 'Sample Labs | 2019 - 2020', 'Maintained reporting tools.']
      ]);
    }
  );

  it.each([
    ['left', 50, 220],
    ['right', 430, 50]
  ])(
    'links titles and metadata on the %s with bodies in the adjacent lane',
    (_side, sideX, bodyX) => {
      const page = layout([
        piece('EXPERIENCE', sideX, 200, 16, true),
        piece('2021 - Present', sideX, 222, 10),
        piece('Example Corp', bodyX, 200, 10),
        piece('Built billing services.', bodyX, 222, 10),
        piece('EDUCATION', sideX, 300, 16, true),
        piece('2019 - 2020', sideX, 322, 10),
        piece('Sample University', bodyX, 300, 10),
        piece('BSc Computer Science', bodyX, 322, 10)
      ]);

      expectRegions(page, [
        [
          'EXPERIENCE',
          ...(sideX < bodyX
            ? ['Example Corp', '2021 - Present', 'Built billing services.']
            : ['Example Corp', 'Built billing services.', '2021 - Present'])
        ],
        [
          'EDUCATION',
          ...(sideX < bodyX
            ? ['Sample University', '2019 - 2020', 'BSc Computer Science']
            : ['Sample University', 'BSc Computer Science', '2019 - 2020'])
        ]
      ]);
    }
  );
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

  it('gives layout authority only to confirmed section headings', () => {
    const page = layout([
      piece('Skills', 72, 80, 18),
      piece('People skills', 72, 110, 14),
      piece('Teamwork', 72, 128, 14),
      piece('Education', 72, 180, 18),
      piece('University of Farland', 72, 210, 14),
      piece('GPA: 3.7', 72, 228, 14),
      ...lines(['Additional body text', 'More body text'], 246)
    ]);

    expect(
      page.regions.flatMap((region) =>
        region.lines.filter((line) => line.heading).map((line) => line.text)
      )
    ).toEqual(['Skills', 'Education']);
  });

  it('repeats heading styles only within the tolerant horizontal lane', () => {
    const page = layout([
      piece('Context before first heading', 72, 184, 10),
      piece('First Topic', 72, 200, 12, true),
      piece('First topic detail', 72, 216, 10),
      piece('Context before second heading', 74, 244, 10),
      piece('Second Topic', 74, 260, 12, true),
      piece('Second topic detail', 74, 276, 10),
      piece('Context in another lane', 300, 304, 10),
      piece('Unrelated Topic', 300, 320, 12, true),
      piece('Unrelated topic detail', 300, 336, 10)
    ]);

    expect(
      page.regions.flatMap((region) =>
        region.lines.filter((line) => line.heading).map((line) => line.text)
      )
    ).toEqual(['First Topic', 'Second Topic']);
  });

  it('promotes a custom heading as same-lane style evidence accumulates', () => {
    const page = layout([
      piece('SUMMARY', 72, 100, 12, true),
      piece('Summary body text', 72, 128, 11),
      piece('PROJECTS', 72, 180, 12, true),
      piece('Projects body text', 72, 208, 11),
      piece('EDUCATION', 72, 260, 12, true),
      piece('Education body text', 72, 288, 11),
      piece('KEY SKILLS', 72, 340, 12, true),
      piece('Languages: TypeScript, Python, SQL', 72, 368, 11, true),
      piece('Backend: Node.js, Express', 72, 384, 11, true)
    ]);

    expect(
      page.regions.flatMap((region) =>
        region.lines.filter((line) => line.heading).map((line) => line.text)
      )
    ).toEqual(['SUMMARY', 'PROJECTS', 'EDUCATION', 'KEY SKILLS']);
  });

  it('keeps a large two-line name as a document title', () => {
    const page = layout([
      piece('Divya', 72, 40, 30),
      piece('Gupta', 72, 75, 30),
      ...lines(['Copywriter', 'sample@example.com', 'Professional summary text'], 120)
    ]);

    expect(page.regions[0]!.lines.slice(0, 2).map((line) => line.heading)).toEqual([true, true]);
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

  it('reattaches columns below a standalone section heading', () => {
    const page = layout([
      piece('Work Experience', 218, 200, 24),
      ...column(218, 250, ['Copywriter', 'Landford Publications', 'Remote', '2020 - Present'], 18),
      ...column(
        410,
        260,
        [
          'Created website copy',
          'for product pages',
          'Edited social posts',
          'for three platforms',
          'Researched topics',
          'with the content team'
        ],
        15
      ),
      piece('References available on request', 40, 500)
    ]);

    expectRegions(page, [
      [
        'Work Experience',
        'Copywriter',
        'Landford Publications',
        'Remote',
        '2020 - Present',
        'Created website copy',
        'for product pages',
        'Edited social posts',
        'for three platforms',
        'Researched topics',
        'with the content team'
      ],
      ['References available on request']
    ]);
    expect(page.regions[0]!.box).toEqual({ x: 218, y: 200, width: 318, height: 147 });
  });

  it('does not give a section ownership of a later region above it', () => {
    const page = layout([
      piece('WORK EXPERIENCE', 50, 220, 16, true),
      piece('Earlier sidebar detail', 320, 170, 10),
      piece('Another earlier detail', 320, 186, 10)
    ]);

    expectRegions(page, [
      ['WORK EXPERIENCE'],
      ['Earlier sidebar detail', 'Another earlier detail']
    ]);
  });

  it('allows small vertical coordinate jitter in forward ownership', () => {
    const page = layout([
      piece('WORK EXPERIENCE', 50, 220, 16, true),
      piece('First detail', 320, 217, 10),
      piece('Second detail', 320, 234, 10),
      piece('Third detail', 320, 250, 10)
    ]);

    expectRegions(page, [
      ['WORK EXPERIENCE', 'First detail', 'Second detail', 'Third detail']
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
        marks: marks.map(({ x, y }) => ({ x, y, width: 4, height: 4 })),
        separators: []
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
