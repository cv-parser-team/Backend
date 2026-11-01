import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createPdfParser, MAX_PDF_PAGES } from './pdf-parser.js';
import { ExtractionResult } from './parsing.types.js';

async function parseFixture(name: string): Promise<ExtractionResult> {
  const content = await readFile(new URL(`./__fixtures__/${name}`, import.meta.url));
  return createPdfParser().parse(new Uint8Array(content));
}

function lineTexts(result: ExtractionResult, pageNumber: number): string[] {
  const page = result.pages.find((candidate) => candidate.pageNumber === pageNumber);
  return page?.lines.map((line) => line.text) ?? [];
}

describe('pdf parser', () => {
  it('extracts ordered lines from a single page', async () => {
    const result = await parseFixture('single-page.pdf');

    expect(result).toMatchObject({
      status: 'succeeded',
      format: 'pdf',
      pageCount: 1,
      failures: []
    });
    expect(lineTexts(result, 1)).toEqual([
      'Sample Candidate',
      'Backend Developer',
      'Experience',
      'Backend Developer at Example Corp',
      '2021-03 to 2023-06'
    ]);
    expect(result.parserVersion).toMatch(/^pdfjs-dist@\d+\.\d+\.\d+$/);
  });

  it('keeps the page number of every line', async () => {
    const result = await parseFixture('multi-page.pdf');

    expect(result.pageCount).toBe(3);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(lineTexts(result, 2)).toContain('Python');
    expect(lineTexts(result, 1)).not.toContain('Python');
  });

  it('measures positions from the top-left corner within the page', async () => {
    const result = await parseFixture('single-page.pdf');
    const page = result.pages[0]!;
    const [first, second] = page.lines;

    expect(page).toMatchObject({ width: 612, height: 792 });
    expect(first!.box.y).toBeLessThan(second!.box.y);
    for (const line of page.lines) {
      expect(line.box.x).toBeGreaterThanOrEqual(0);
      expect(line.box.y).toBeGreaterThanOrEqual(0);
      expect(line.box.x + line.box.width).toBeLessThanOrEqual(page.width);
      expect(line.box.y + line.box.height).toBeLessThanOrEqual(page.height);
      expect(line.pieces.length).toBeGreaterThan(0);
    }
  });

  it('does not merge text from side-by-side columns', async () => {
    const result = await parseFixture('two-column.pdf');
    const texts = lineTexts(result, 1);

    expect(texts).toContain('Skills');
    expect(texts).toContain('Experience');
    expect(texts.some((text) => text.includes('Skills') && text.includes('Experience'))).toBe(false);
  });

  it('keeps text pages when a scanned page has no text', async () => {
    const result = await parseFixture('scanned-page.pdf');

    expect(result.status).toBe('partial');
    expect(result.pageCount).toBe(2);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1]);
    expect(result.failures).toEqual([{ pageNumber: 2, code: 'NO_TEXT_LAYER' }]);
  });

  it('fails password-protected files', async () => {
    const result = await parseFixture('password-protected.pdf');

    expect(result).toMatchObject({
      status: 'failed',
      pages: [],
      failures: [{ pageNumber: null, code: 'PASSWORD_PROTECTED' }]
    });
  });

  it('fails unreadable files', async () => {
    const result = await parseFixture('corrupt.pdf');

    expect(result).toMatchObject({
      status: 'failed',
      failures: [{ pageNumber: null, code: 'UNREADABLE' }]
    });
  });

  it(`rejects files with more than ${MAX_PDF_PAGES} pages without reading them`, async () => {
    const result = await parseFixture('too-many-pages.pdf');

    expect(result).toMatchObject({
      status: 'failed',
      pageCount: 5,
      pages: [],
      failures: [{ pageNumber: null, code: 'TOO_MANY_PAGES' }]
    });
  });
});
