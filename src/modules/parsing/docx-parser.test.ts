import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDocxParser } from './docx-parser.js';
import { ExtractionResult } from './parsing.types.js';

async function parseFixture(name: string): Promise<ExtractionResult> {
  const content = await readFile(new URL(`./__fixtures__/${name}`, import.meta.url));
  return createDocxParser().parse(new Uint8Array(content));
}

describe('docx parser', () => {
  it('extracts ordered paragraph blocks without pages', async () => {
    const result = await parseFixture('resume.docx');

    expect(result).toMatchObject({
      status: 'succeeded',
      format: 'docx',
      pageCount: null,
      pages: [],
      failures: []
    });
    expect(result.blocks.map((block) => block.type === 'paragraph' && block.text)).toEqual([
      'Sample Candidate',
      'Backend Developer',
      'Experience',
      'Backend Developer at Example Corp',
      'Skills',
      'Python, Node.js'
    ]);
    expect(result.blocks.map((block) => block.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.parserVersion).toMatch(/^mammoth@\d+\.\d+\.\d+$/);
  });

  it('keeps table rows and cells together', async () => {
    const result = await parseFixture('table.docx');

    expect(result.blocks).toEqual([
      expect.objectContaining({ type: 'paragraph', text: 'Sample Candidate' }),
      {
        type: 'table',
        index: 1,
        columns: null,
        rows: [
          ['Skill', 'Level'],
          ['Python', 'Advanced'],
          ['Docker', 'Intermediate']
        ]
      },
      expect.objectContaining({ type: 'paragraph', text: 'References available on request' })
    ]);
  });

  it('keeps column headings only when Word marks a header row', async () => {
    const result = await parseFixture('table-header.docx');

    expect(result.blocks[1]).toEqual({
      type: 'table',
      index: 1,
      columns: ['Position', 'Company', 'Period'],
      rows: [
        ['Backend Developer', 'ABC Company', '2021 - 2023'],
        ['Intern', 'XYZ Ltd', '2020 - 2021']
      ]
    });
  });

  it('fails documents without text', async () => {
    const result = await parseFixture('empty.docx');

    expect(result).toMatchObject({
      status: 'failed',
      blocks: [],
      failures: [{ pageNumber: null, code: 'NO_TEXT_LAYER' }]
    });
  });

  it('fails documents that are mostly Arabic', async () => {
    const result = await parseFixture('arabic.docx');

    expect(result).toMatchObject({
      status: 'failed',
      blocks: [],
      failures: [{ pageNumber: null, code: 'UNSUPPORTED_LANGUAGE' }]
    });
  });

  it('fails files that are not readable Word documents', async () => {
    const result = await parseFixture('corrupt.pdf');

    expect(result).toMatchObject({
      status: 'failed',
      format: 'docx',
      failures: [{ pageNumber: null, code: 'UNREADABLE' }]
    });
  });
});
