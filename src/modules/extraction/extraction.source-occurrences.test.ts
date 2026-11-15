import { describe, expect, it } from 'vitest';
import type {
  DocumentBlock,
  ParsedPage,
  TextLine
} from '../parsing/parsing.types.js';
import { SourceReferenceResolutionError } from './extraction.errors.js';
import type { ClaimDraft } from './extraction.mapper.js';
import { mapClaimSourceOccurrences } from './extraction.source-occurrences.js';

function line(order: number, text: string, y: number): TextLine {
  return {
    order,
    text,
    box: { x: 40, y, width: 240, height: 12 },
    heading: false,
    bold: false,
    italic: false,
    bullet: false,
    links: []
  };
}

function page(lines: TextLine[]): ParsedPage {
  return {
    pageNumber: 1,
    width: 612,
    height: 792,
    regions: [
      {
        index: 2,
        box: { x: 30, y: 30, width: 300, height: 100 },
        role: 'section',
        confidence: 0.4,
        lines
      }
    ]
  };
}

function claim(fieldSources: Record<string, string[]>): Pick<ClaimDraft, 'fieldSources'> {
  return { fieldSources };
}

describe('claim source occurrence mapping', () => {
  it('expands ranges and deduplicates shared field citations by physical line', () => {
    const drafts = mapClaimSourceOccurrences(
      claim({
        employer: ['L1-2'],
        jobTitle: ['L1-2'],
        startDate: ['L3'],
        description: ['L2', 'L2']
      }),
      {
        pages: [
          page([
            line(1, 'Backend Engineer', 40),
            line(2, 'Example Labs', 56),
            line(3, 'January 2022 - Present', 72)
          ])
        ],
        blocks: []
      }
    );

    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toMatchObject({
      anchorKey: 'pdf:1:1',
      references: ['L1-2'],
      fields: ['employer', 'jobTitle'],
      anchor: { kind: 'pdf_line', order: 1, text: 'Backend Engineer' }
    });
    expect(drafts[1]).toMatchObject({
      anchorKey: 'pdf:1:2',
      references: ['L1-2', 'L2'],
      fields: ['employer', 'jobTitle', 'description'],
      anchor: { kind: 'pdf_line', order: 2, text: 'Example Labs' }
    });
    expect(drafts[2]).toMatchObject({
      anchorKey: 'pdf:1:3',
      references: ['L3'],
      fields: ['startDate'],
      anchor: {
        kind: 'pdf_line',
        order: 3,
        text: 'January 2022 - Present'
      }
    });
    expect(drafts[0]).not.toHaveProperty('section');
  });

  it('maps a DOCX row once while retaining every supporting field', () => {
    const blocks: DocumentBlock[] = [
      {
        type: 'table',
        index: 4,
        columns: ['Skill', 'Level'],
        rows: [['TypeScript', 'Advanced']]
      }
    ];

    expect(
      mapClaimSourceOccurrences(
        claim({ name: ['B4.1'], proficiency: ['B4.1'] }),
        { pages: [], blocks }
      )
    ).toEqual([
      {
        anchorKey: 'docx:4:1',
        references: ['B4.1'],
        fields: ['name', 'proficiency'],
        anchor: {
          kind: 'docx_table_row',
          blockIndex: 4,
          rowNumber: 1,
          cells: ['TypeScript', 'Advanced']
        }
      }
    ]);
  });

  it('fails when any citation is missing or physically ambiguous', () => {
    const duplicate = line(1, 'Duplicate line order', 56);

    expect(() =>
      mapClaimSourceOccurrences(
        claim({ name: ['L1', 'L9'] }),
        {
          pages: [page([line(1, 'First line', 40), duplicate])],
          blocks: []
        }
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'SOURCE_REFERENCE_RESOLUTION_FAILED',
        missing: ['L9'],
        ambiguous: ['L1']
      })
    );
    expect(() =>
      mapClaimSourceOccurrences(claim({ name: ['L9'] }), {
        pages: [],
        blocks: []
      })
    ).toThrow(SourceReferenceResolutionError);
  });
});
