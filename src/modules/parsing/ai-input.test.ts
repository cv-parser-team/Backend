import { describe, expect, it } from 'vitest';
import { buildAiInput } from './ai-input.js';
import { DocumentBlock, ParsedPage, Region, TextLine } from './parsing.types.js';

interface LineOptions {
  x?: number;
  width?: number;
  heading?: boolean;
  bold?: boolean;
  italic?: boolean;
  bullet?: boolean;
  links?: string[];
}

// Lines are 12pt high with a 4pt gap unless a test places them itself.
function line(order: number, text: string, y: number, options: LineOptions = {}): TextLine {
  const height = options.heading ? 16 : 12;
  return {
    order,
    text,
    box: { x: options.x ?? 50, y, width: options.width ?? 400, height },
    heading: options.heading ?? false,
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    bullet: options.bullet ?? false,
    links: options.links ?? []
  };
}

function region(index: number, lines: TextLine[]): Region {
  const left = Math.min(...lines.map((item) => item.box.x));
  const right = Math.max(...lines.map((item) => item.box.x + item.box.width));
  const top = Math.min(...lines.map((item) => item.box.y));
  const bottom = Math.max(...lines.map((item) => item.box.y + item.box.height));
  return {
    index,
    box: { x: left, y: top, width: right - left, height: bottom - top },
    confidence: null,
    lines
  };
}

function page(pageNumber: number, regions: Region[]): ParsedPage {
  return { pageNumber, width: 612, height: 792, regions };
}

function pdfInput(pages: ParsedPage[]): string {
  return buildAiInput({ pages, blocks: [] });
}

describe('ai input for pdf pages', () => {
  it('marks regions, headings, and bold lines with line references', () => {
    const input = pdfInput([
      page(1, [
        region(1, [line(1, 'Sample Candidate', 40, { heading: true })]),
        region(2, [
          line(2, 'Experience', 80, { heading: true }),
          line(3, 'Backend Developer', 100, { bold: true, width: 120 }),
          line(4, 'Example Corp', 116, { width: 90 })
        ])
      ]),
      page(2, [region(1, [line(5, 'Skills', 40, { heading: true })])])
    ]);

    expect(input).toBe(
      [
        '[P1 R1]',
        '## L1 Sample Candidate',
        '[P1 R2]',
        '## L2 Experience',
        'L3 *Backend Developer*',
        'L4 Example Corp',
        '[P2 R1]',
        '## L5 Skills'
      ].join('\n')
    );
  });

  it('lists links hidden behind text and skips links written in it', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Email: sample@example.com', 100, {
            width: 150,
            links: ['mailto:sample@example.com']
          }),
          line(2, 'LinkedIn · github.com/sample', 116, {
            width: 160,
            links: ['https://www.linkedin.com/in/sample', 'https://github.com/sample/']
          })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1 Email: sample@example.com',
      'L2 LinkedIn · github.com/sample (links: https://www.linkedin.com/in/sample)'
    ]);
  });

  it('removes letter spacing from spaced-out headings only', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'C O N T A C T :', 100, { heading: true }),
          line(2, 'A B O U T M E', 120, { heading: true }),
          line(3, 'Grade A B C average', 140, { width: 120 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      '## L1 CONTACT:',
      '## L2 ABOUTME',
      'L3 Grade A B C average'
    ]);
  });

  it('keeps the cells of one row on one line', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Backend Developer, Example Corp', 100, { bold: true, width: 190 }),
          line(2, 'Oct 2023 - Present', 100, { x: 450, width: 100, bold: true }),
          line(3, 'Built tracking and billing services for the payments', 116),
          line(4, 'Harumi Kobayashi', 160, { width: 100, bold: true }),
          line(5, 'Bailey Dupont', 160, { x: 300, width: 80, bold: true }),
          line(6, 'Phone: 123-456-7890', 176, { width: 110 }),
          line(7, 'Phone: 123-456-7891', 176, { x: 300, width: 110 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1-2 *Backend Developer, Example Corp* | *Oct 2023 - Present*',
      'L3 Built tracking and billing services for the payments',
      'L4-5 *Harumi Kobayashi* | *Bailey Dupont*',
      'L6-7 Phone: 123-456-7890 | Phone: 123-456-7891'
    ]);
  });

  it('continues a wrapped cell of a grid in its own column', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Classically trained chef proficient in', 100, { width: 200 }),
          line(2, 'Expertise with protocol and table', 100, { x: 300, width: 190 }),
          line(3, 'food production', 116, { width: 90 }),
          line(4, 'service for many settings', 116, { x: 300, width: 140 }),
          line(5, 'Fast learner', 132, { width: 70 }),
          line(6, 'Team player', 132, { x: 300, width: 65 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1-4 Classically trained chef proficient in food production | Expertise with protocol and table service for many settings',
      'L5-6 Fast learner | Team player'
    ]);
  });

  it('joins the rest of a list item that has no bullet of its own', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Client Acquisition', 100, { width: 100, bullet: true }),
          line(2, 'Relationship', 100, { x: 300, width: 70, bullet: true }),
          line(3, 'B2B Sales', 116, { width: 55, bullet: true }),
          line(4, 'Management', 116, { x: 300, width: 65 }),
          line(5, 'Negotiation', 132, { width: 65, bullet: true }),
          line(6, 'Market Analysis', 132, { x: 300, width: 85, bullet: true })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1-2,4 • Client Acquisition | • Relationship Management',
      'L3 • B2B Sales',
      'L5-6 • Negotiation | • Market Analysis'
    ]);
  });

  it('does not join the line under a lone dot, such as a timeline marker', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Product Design Manager', 100, { width: 130, bullet: true }),
          line(2, 'Arowwai Industries', 116, { width: 100 }),
          line(3, 'Marketing Manager', 228, { width: 100, bullet: true }),
          line(4, 'Borcelle Studio', 244, { width: 90 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1 • Product Design Manager',
      'L2 Arowwai Industries',
      'L3 • Marketing Manager',
      'L4 Borcelle Studio'
    ]);
  });

  it('marks italic and bold italic text', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Product Design Manager', 100, { width: 130 }),
          line(2, 'Arowwai Industries', 116, { width: 100, italic: true }),
          line(3, 'Lead Designer', 132, { width: 80, bold: true, italic: true })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1 Product Design Manager',
      'L2 _Arowwai Industries_',
      'L3 *_Lead Designer_*'
    ]);
  });

  it('joins a heading that continues on the next line at the same size', () => {
    const name = (order: number, text: string, y: number, height = 40) => ({
      ...line(order, text, y, { heading: true, width: 200 }),
      box: { x: 250, y, width: 200, height }
    });
    const input = pdfInput([
      page(1, [
        region(1, [
          name(1, 'LORNA', 50),
          name(2, 'ALVARADO', 92),
          name(3, 'Sales Representative', 140, 18),
          name(4, 'Experience', 200, 18)
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      '## L1-2 LORNA ALVARADO',
      '## L3 Sales Representative',
      '## L4 Experience'
    ]);
  });

  it('marks a row of headings as a heading', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Harumi Kobayashi', 100, { heading: true, width: 100 }),
          line(2, 'Bailey Dupont', 100, { heading: true, x: 300, width: 80 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual(['## L1-2 Harumi Kobayashi | Bailey Dupont']);
  });

  it('joins a description that wraps over several lines', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Built REST APIs with Node.js and PostgreSQL for the', 100),
          line(2, 'payments team, reducing response times by', 116),
          line(3, 'forty percent.', 132, { width: 80 }),
          line(4, 'Led the migration to Docker.', 148, { width: 160 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1-3 Built REST APIs with Node.js and PostgreSQL for the payments team, reducing response times by forty percent.',
      'L4 Led the migration to Docker.'
    ]);
  });

  it('joins a bullet with the indented line under it', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, '• Designed role-based access control for the admin', 100),
          line(2, 'dashboard and public API', 116, { x: 60, width: 150 }),
          line(3, '• Wrote integration tests', 132, { width: 140 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1-2 • Designed role-based access control for the admin dashboard and public API',
      'L3 • Wrote integration tests'
    ]);
  });

  it('keeps short items in a narrow sidebar apart', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Python', 100, { x: 450, width: 36 }),
          line(2, 'Node.js', 116, { x: 450, width: 42 }),
          line(3, 'Spring Boot', 132, { x: 450, width: 66 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual(['L1 Python', 'L2 Node.js', 'L3 Spring Boot']);
  });

  it('joins narrow lines only when the sentence visibly continues', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, '+1 555 0100 extension 25', 100, { x: 450, width: 70 }),
          line(2, 'Springfield', 116, { x: 450, width: 60 }),
          line(3, 'Object-Oriented Programming', 132, { x: 450, width: 70 }),
          line(4, '(OOP), Databases', 148, { x: 450, width: 50 })
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1 +1 555 0100 extension 25',
      'L2 Springfield',
      'L3-4 Object-Oriented Programming (OOP), Databases'
    ]);
  });

  it('keeps a line apart when the next word would have fitted after it', () => {
    const input = pdfInput([
      page(1, [
        region(1, [
          line(1, 'Backend Developer at Example Corp', 100, { width: 200 }),
          line(2, 'Built REST APIs with Node.js and PostgreSQL for payments', 116)
        ])
      ])
    ]);

    expect(input.split('\n').slice(1)).toEqual([
      'L1 Backend Developer at Example Corp',
      'L2 Built REST APIs with Node.js and PostgreSQL for payments'
    ]);
  });

  it.each([
    ['the first line ends a sentence', line(1, 'Built REST APIs with Node.js.', 100), line(2, 'Wrote tests', 116)],
    ['the first line ends with a colon', line(1, 'Key responsibilities included:', 100), line(2, 'Wrote tests', 116)],
    ['the next line is a bullet', line(1, 'Built REST APIs with Node.js', 100), line(2, '• Wrote tests', 116)],
    ['the next line is a date', line(1, 'Backend Developer at Example Corp', 100), line(2, '2021 - 2023', 116)],
    ['the next line is an email', line(1, 'You can reach me by phone or', 100), line(2, 'hello@example.com', 116)],
    ['the next line is a website', line(1, 'Portfolio and case studies are on', 100), line(2, 'www.example.com', 116)],
    ['the next line starts with a month', line(1, 'Backend Developer at Example Corp', 100), line(2, 'Jan 2021 - Present', 116)],
    ['the bold style changes', line(1, 'Backend Developer at Example Corp', 100, { bold: true }), line(2, 'Built REST APIs', 116)],
    ['the next line is a heading', line(1, 'Backend Developer at Example Corp', 100), line(2, 'Skills', 116, { heading: true })],
    ['the lines do not line up', line(1, 'Backend Developer at Example Corp', 100), line(2, 'Built REST APIs', 116, { x: 300, width: 150 })],
    ['the gap is a section break', line(1, 'Backend Developer at Example Corp', 100), line(2, 'Built REST APIs', 140)]
  ])('keeps lines apart when %s', (_reason, first, second) => {
    const spacing = [line(10, 'Normal spacing line one for the usual gap', 300), line(11, 'Normal spacing line two', 316)];
    const input = pdfInput([page(1, [region(1, [first, second]), region(2, spacing)])]);

    expect(input).toContain(`\nL${first.order} `);
    expect(input).toMatch(new RegExp(`\\n(## )?L${second.order} `));
  });
});

describe('ai input for docx blocks', () => {
  it('uses block references, headings, bold, hidden links, and tables', () => {
    const blocks: DocumentBlock[] = [
      { type: 'paragraph', index: 0, text: 'Sample Candidate', heading: true, bold: true, italic: false, links: [] },
      {
        type: 'paragraph',
        index: 1,
        text: 'LinkedIn · https://github.com/sample',
        heading: false,
        bold: false,
        italic: false,
        links: ['https://www.linkedin.com/in/sample', 'https://github.com/sample']
      },
      { type: 'paragraph', index: 2, text: 'Backend Developer', heading: false, bold: true, italic: false, links: [] },
      {
        type: 'table',
        index: 3,
        columns: ['Position', 'Company'],
        rows: [
          ['Developer', 'ABC Company'],
          ['Intern', 'XYZ Ltd']
        ]
      },
      { type: 'table', index: 4, columns: null, rows: [['Python', 'Advanced']] }
    ];

    expect(buildAiInput({ pages: [], blocks })).toBe(
      [
        '## B0 Sample Candidate',
        'B1 LinkedIn · https://github.com/sample (links: https://www.linkedin.com/in/sample)',
        'B2 *Backend Developer*',
        'Columns: Position | Company',
        'B3.1 Developer | ABC Company',
        'B3.2 Intern | XYZ Ltd',
        'B4.1 Python | Advanced'
      ].join('\n')
    );
  });
});
