import { readFile } from 'node:fs/promises';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  createPdfParser,
  extractDrawnPrimitives,
  MAX_PDF_PAGES
} from './pdf-parser.js';
import { ExtractionResult, ParsedPage, TextLine } from './parsing.types.js';

async function parseFixture(name: string): Promise<ExtractionResult> {
  const content = await readFile(new URL(`./__fixtures__/${name}`, import.meta.url));
  return createPdfParser().parse(new Uint8Array(content));
}

function pageLines(page: ParsedPage): TextLine[] {
  return page.regions.flatMap((region) => region.lines);
}

function lineTexts(result: ExtractionResult, pageNumber: number): string[] {
  const page = result.pages.find((candidate) => candidate.pageNumber === pageNumber);
  return page ? pageLines(page).map((line) => line.text) : [];
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

function pathArgs(
  box: [number, number, number, number],
  paintOperator?: number
): unknown[] {
  return [paintOperator ?? [], [], box];
}

describe('PDF drawn primitives', () => {
  it('extracts horizontal and vertical stroked separators with transformed thickness', () => {
    const horizontal = extractDrawnPrimitives(
      {
        fnArray: [OPS.setLineWidth, OPS.constructPath, OPS.stroke],
        argsArray: [[2], pathArgs([10, 20, 110, 20]), null]
      },
      IDENTITY
    );
    const vertical = extractDrawnPrimitives(
      {
        fnArray: [
          OPS.save,
          OPS.transform,
          OPS.setLineWidth,
          OPS.constructPath,
          OPS.stroke,
          OPS.restore
        ],
        argsArray: [null, [2, 0, 0, 2, 5, 7], [1], pathArgs([10, 10, 10, 60]), null, null]
      },
      IDENTITY
    );

    expect(horizontal.separators).toEqual([{
      orientation: 'horizontal',
      box: { x: 10, y: 19, width: 100, height: 2 },
      thickness: 2
    }]);
    expect(vertical.separators).toEqual([{
      orientation: 'vertical',
      box: { x: 24, y: 27, width: 2, height: 100 },
      thickness: 2
    }]);
  });

  it('keeps thin filled rectangles separate from small bullet marks', () => {
    const primitives = extractDrawnPrimitives(
      {
        fnArray: [
          OPS.constructPath,
          OPS.constructPath,
          OPS.fill
        ],
        argsArray: [pathArgs([10, 40, 110, 42], OPS.fill), pathArgs([5, 5, 9, 9]), null]
      },
      IDENTITY
    );

    expect(primitives.separators).toEqual([{
      orientation: 'horizontal',
      box: { x: 10, y: 40, width: 100, height: 2 },
      thickness: 2
    }]);
    expect(primitives.marks).toEqual([{ x: 5, y: 5, width: 4, height: 4 }]);
  });

  it('ignores diagonal and background shapes and deduplicates overlapping rules', () => {
    const primitives = extractDrawnPrimitives(
      {
        fnArray: [
          OPS.constructPath,
          OPS.stroke,
          OPS.constructPath,
          OPS.fill,
          OPS.constructPath,
          OPS.fill,
          OPS.constructPath,
          OPS.fill
        ],
        argsArray: [
          pathArgs([10, 10, 100, 100]),
          null,
          pathArgs([0, 0, 600, 800]),
          null,
          pathArgs([10, 40, 110, 42]),
          null,
          pathArgs([10.5, 40, 110.5, 42]),
          null
        ]
      },
      IDENTITY
    );

    expect(primitives.separators).toEqual([{
      orientation: 'horizontal',
      box: { x: 10, y: 40, width: 100, height: 2 },
      thickness: 2
    }]);
    expect(primitives.marks).toEqual([]);
  });
});

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
    const [first, second] = pageLines(page);

    expect(page).toMatchObject({ width: 612, height: 792 });
    expect(first!.box.y).toBeLessThan(second!.box.y);
    for (const line of pageLines(page)) {
      expect(line.box.x).toBeGreaterThanOrEqual(0);
      expect(line.box.y).toBeGreaterThanOrEqual(0);
      expect(line.box.x + line.box.width).toBeLessThanOrEqual(page.width);
      expect(line.box.y + line.box.height).toBeLessThanOrEqual(page.height);
    }
  });

  it('numbers lines in reading order across the whole document', async () => {
    const result = await parseFixture('multi-page.pdf');
    const orders = result.pages.flatMap((page) => pageLines(page).map((line) => line.order));

    expect(orders).toEqual(orders.map((_, index) => index + 1));
    expect(result.pages[1]!.regions[0]!.lines[0]!.order).toBe(pageLines(result.pages[0]!).length + 1);
  });

  it('keeps an unresolved page as one independent region', async () => {
    const result = await parseFixture('single-page.pdf');

    expect(result.pages[0]!.regions).toHaveLength(1);
    expect(result.pages[0]!.regions[0]).toMatchObject({
      index: 0,
      role: 'independent',
      parentIndex: null,
      confidence: 0.5
    });
  });

  it('does not merge text from side-by-side columns', async () => {
    const result = await parseFixture('two-column.pdf');
    const texts = lineTexts(result, 1);

    expect(texts).toContain('Skills');
    expect(texts).toContain('Experience');
    expect(texts.some((text) => text.includes('Skills') && text.includes('Experience'))).toBe(false);
  });

  it('keeps an ambiguous sidebar and main column together', async () => {
    const result = await parseFixture('sidebar-columns.pdf');
    const regions = result.pages[0]!.regions;

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ role: 'independent', parentIndex: null });
    expect(regions[0]!.lines.map((line) => line.text)).toEqual(
      expect.arrayContaining(['Contact', 'Experience', 'Skills', 'Education'])
    );
    expect(pageLines(result.pages[0]!).map((line) => line.order)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1)
    );
  });

  it('keeps unresolved columns under a full-width header in one final region', async () => {
    const result = await parseFixture('header-columns.pdf');

    expect(result.pages[0]!.regions).toHaveLength(1);
    expect(lineTexts(result, 1)).toEqual(expect.arrayContaining([
      'Sample Candidate',
      'Experience',
      'Skills',
      'Languages'
    ]));
  });

  it('keeps unresolved parallel heading lanes together', async () => {
    const result = await parseFixture('sidebar-headings.pdf');

    expect(result.pages[0]!.regions).toHaveLength(1);
    expect(lineTexts(result, 1)).toEqual(expect.arrayContaining([
      'Contact',
      'About Me',
      'Skills',
      'Experience'
    ]));
  });

  it('reads bold and italic from font names, including short forms', async () => {
    const result = await parseFixture('font-styles.pdf');

    expect(pageLines(result.pages[0]!).map((line) => [line.text, line.bold, line.italic])).toEqual([
      ['Regular text', false, false],
      ['Italic company name', false, true],
      ['Short bold name', true, false],
      ['Bold italic name', true, true]
    ]);
  });

  it('finds list bullets drawn as shapes, including inside embedded forms', async () => {
    const result = await parseFixture('drawn-bullets.pdf');

    expect(pageLines(result.pages[0]!).map((line) => [line.text, line.bullet])).toEqual([
      ['KEY SKILLS', false],
      ['Client Acquisition', true],
      ['Relationship', true],
      ['B2B Sales', true],
      ['Management', false],
      ['Negotiation', true],
      ['Market Analysis', true]
    ]);
  });

  it('keeps the word breaks of headings with spaced-out letters', async () => {
    const result = await parseFixture('spaced-headings.pdf');

    expect(lineTexts(result, 1)).toEqual([
      'ABOUT ME',
      'Backend developer with five years of experience.',
      'WORK EXPERIENCE',
      'Backend Developer at Example Corp'
    ]);
  });

  it('keeps link targets placed over the text of a line', async () => {
    const result = await parseFixture('links.pdf');

    expect(pageLines(result.pages[0]!).map((line) => [line.text, line.links])).toEqual([
      ['Sample Candidate', []],
      ['Email: sample@example.com', ['mailto:sample@example.com']],
      ['Links: LinkedIn GitHub', ['https://www.linkedin.com/in/sample', 'https://github.com/sample']]
    ]);
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

  it('fails files that are mostly Arabic', async () => {
    const result = await parseFixture('arabic.pdf');

    expect(result).toMatchObject({
      status: 'failed',
      pageCount: 1,
      pages: [],
      failures: [{ pageNumber: null, code: 'UNSUPPORTED_LANGUAGE' }]
    });
  });

  it('removes small Arabic fragments and keeps the rest', async () => {
    const result = await parseFixture('mostly-english.pdf');
    const texts = lineTexts(result, 1);

    expect(result.status).toBe('succeeded');
    expect(texts).toContain('Python, Node.js, PostgreSQL, Docker, Linux');
    expect(texts).toContain('Languages: English and');
    expect(texts.join(' ')).not.toMatch(/[؀-ۿﹰ-﻿]/);
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
