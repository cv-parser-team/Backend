import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDocxParser } from './docx-parser.js';
import { ExtractionResult } from './parsing.types.js';

async function parseFixture(name: string): Promise<ExtractionResult> {
  const content = await readFile(new URL(`./__fixtures__/${name}`, import.meta.url));
  return createDocxParser().parse(new Uint8Array(content));
}

describe('docx parser', () => {
  it('extracts ordered paragraphs without pages', async () => {
    const result = await parseFixture('resume.docx');

    expect(result).toMatchObject({
      status: 'succeeded',
      format: 'docx',
      pageCount: null,
      pages: [],
      failures: []
    });
    expect(result.paragraphs).toEqual([
      { index: 0, text: 'Sample Candidate' },
      { index: 1, text: 'Backend Developer' },
      { index: 2, text: 'Experience' },
      { index: 3, text: 'Backend Developer at Example Corp' },
      { index: 4, text: 'Skills' },
      { index: 5, text: 'Python, Node.js' }
    ]);
    expect(result.parserVersion).toMatch(/^mammoth@\d+\.\d+\.\d+$/);
  });

  it('extracts table cells in reading order', async () => {
    const result = await parseFixture('table.docx');

    expect(result.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      'Sample Candidate',
      'Skill',
      'Level',
      'Python',
      'Advanced',
      'Docker',
      'Intermediate',
      'References available on request'
    ]);
  });

  it('fails documents without text', async () => {
    const result = await parseFixture('empty.docx');

    expect(result).toMatchObject({
      status: 'failed',
      paragraphs: [],
      failures: [{ pageNumber: null, code: 'NO_TEXT_LAYER' }]
    });
  });

  it('fails documents that are mostly Arabic', async () => {
    const result = await parseFixture('arabic.docx');

    expect(result).toMatchObject({
      status: 'failed',
      paragraphs: [],
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
