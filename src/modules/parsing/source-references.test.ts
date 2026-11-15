import { describe, expect, it } from 'vitest';
import type {
  DocumentBlock,
  ParsedPage,
  TextLine
} from './parsing.types.js';
import { resolveSourceReferences } from './source-references.js';

function line(order: number, text: string, y: number): TextLine {
  return {
    order,
    text,
    box: { x: 50, y, width: 200, height: 12 },
    heading: true,
    bold: false,
    italic: false,
    bullet: false,
    links: []
  };
}

function page(pageNumber: number, lines: TextLine[]): ParsedPage {
  return {
    pageNumber,
    width: 612,
    height: 792,
    regions: [
      {
        index: 7,
        box: { x: 40, y: 20, width: 500, height: 300 },
        role: 'section',
        confidence: 0.2,
        lines
      }
    ]
  };
}

describe('physical source reference resolution', () => {
  it('resolves PDF ranges to original lines without inferred semantics', () => {
    const result = resolveSourceReferences(
      {
        pages: [
          page(1, [line(1, 'EXPERIENCE', 40), line(2, 'Example Labs', 60)]),
          page(2, [line(3, 'Backend Engineer', 40), line(4, '2022 - Present', 60)])
        ],
        blocks: []
      },
      ['L1-2,4']
    );

    expect(result).toEqual({
      resolved: [
        {
          reference: 'L1-2,4',
          anchors: [
            {
              kind: 'pdf_line',
              order: 1,
              pageNumber: 1,
              box: { x: 50, y: 40, width: 200, height: 12 },
              text: 'EXPERIENCE',
              links: []
            },
            {
              kind: 'pdf_line',
              order: 2,
              pageNumber: 1,
              box: { x: 50, y: 60, width: 200, height: 12 },
              text: 'Example Labs',
              links: []
            },
            {
              kind: 'pdf_line',
              order: 4,
              pageNumber: 2,
              box: { x: 50, y: 60, width: 200, height: 12 },
              text: '2022 - Present',
              links: []
            }
          ]
        }
      ],
      missing: [],
      ambiguous: []
    });
    expect(result.resolved[0]!.anchors[0]).not.toHaveProperty('heading');
    expect(result.resolved[0]!.anchors[0]).not.toHaveProperty('regionRole');
  });

  it('resolves DOCX paragraphs and table rows to stored content', () => {
    const blocks: DocumentBlock[] = [
      {
        type: 'paragraph',
        index: 3,
        text: 'Portfolio',
        heading: true,
        bold: true,
        italic: false,
        links: ['https://example.com']
      },
      {
        type: 'table',
        index: 4,
        columns: ['Skill', 'Level'],
        rows: [['TypeScript', 'Advanced']]
      }
    ];

    expect(
      resolveSourceReferences({ pages: [], blocks }, ['B3', 'B4.1'])
    ).toEqual({
      resolved: [
        {
          reference: 'B3',
          anchors: [
            {
              kind: 'docx_paragraph',
              blockIndex: 3,
              text: 'Portfolio',
              links: ['https://example.com']
            }
          ]
        },
        {
          reference: 'B4.1',
          anchors: [
            {
              kind: 'docx_table_row',
              blockIndex: 4,
              rowNumber: 1,
              cells: ['TypeScript', 'Advanced']
            }
          ]
        }
      ],
      missing: [],
      ambiguous: []
    });
  });

  it('deduplicates input and reports missing or ambiguous anchors', () => {
    const duplicateLine = line(1, 'Duplicate order', 80);
    const duplicateBlocks: DocumentBlock[] = [
      {
        type: 'paragraph',
        index: 2,
        text: 'First',
        heading: false,
        bold: false,
        italic: false,
        links: []
      },
      {
        type: 'paragraph',
        index: 2,
        text: 'Second',
        heading: false,
        bold: false,
        italic: false,
        links: []
      }
    ];

    expect(
      resolveSourceReferences(
        {
          pages: [page(1, [line(1, 'First order', 40), duplicateLine])],
          blocks: duplicateBlocks
        },
        ['L1', 'B2', 'L9', 'L9', 'B2.1']
      )
    ).toEqual({
      resolved: [],
      missing: ['L9'],
      ambiguous: ['L1', 'B2', 'B2.1']
    });
  });
});
