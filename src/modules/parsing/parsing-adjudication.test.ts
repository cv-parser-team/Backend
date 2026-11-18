import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { LayoutTrace } from './layout.js';
import {
  ADJUDICATION_OPTIONS,
  collectAdjudicationCases,
  lineRef,
  NEARBY_LINE_COUNT
} from './parsing-adjudication.js';
import { createPdfParser } from './pdf-parser.js';

async function traceOf(path: URL): Promise<LayoutTrace> {
  let trace: LayoutTrace | undefined;
  await createPdfParser({ onLayoutTrace: (built) => (trace = built) }).parse(
    new Uint8Array(await readFile(path))
  );
  if (!trace) {
    throw new Error('No layout trace');
  }
  return trace;
}

const cv = (name: string) => new URL(`../../../manual-tests/documents/${name}`, import.meta.url);
const fixture = (name: string) => new URL(`./__fixtures__/${name}`, import.meta.url);

describe('collecting uncertain parser decisions', () => {
  it.each(['two-column.pdf', 'sidebar-headings.pdf', 'header-columns.pdf', 'multi-page.pdf'])(
    'asks nothing about a CV whose decisions are confident: %s',
    async (name) => {
      expect(collectAdjudicationCases(await traceOf(fixture(name)))).toEqual([]);
    }
  );

  it('finds uncertain headings and gutters in a real CV', async () => {
    const cases = collectAdjudicationCases(await traceOf(cv('Arisha.pdf')));

    expect(cases.map((item) => item.kind)).toEqual([
      'heading_role',
      'heading_role',
      'heading_role',
      'gutter_meaning'
    ]);
    const gutter = cases.find((item) => item.kind === 'gutter_meaning')!;
    expect(gutter.lineRefs).toHaveLength(2);
    expect(gutter.deterministic).toBe('shared_section');
  });

  it('describes every case with its options, the current decision, and nearby text', async () => {
    const trace = await traceOf(cv('Eleanor.pdf'));
    const cases = collectAdjudicationCases(trace);

    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      expect(item.options).toEqual(ADJUDICATION_OPTIONS[item.kind]);
      expect(item.options).toContain(item.deterministic);
      expect(item.caseId).toBe(`${item.kind}:${item.lineRefs.join(',')}`);
      expect(item.lineRefs).toEqual(
        item.lineIndexes.map((lineIndex) => lineRef(item.pageNumber, lineIndex))
      );
      for (const ref of item.lineRefs) {
        expect(item.context.some((line) => line.startsWith(`${ref}:`) || line.startsWith(`${ref} `))).toBe(true);
      }
      expect(item.context.length).toBeLessThanOrEqual(item.lineIndexes.length + NEARBY_LINE_COUNT * 2);
    }
  });

  it('never asks about one line twice', async () => {
    for (const name of ['Arisha.pdf', 'Eleanor.pdf']) {
      const refs = collectAdjudicationCases(await traceOf(cv(name))).flatMap(
        (item) => item.lineRefs
      );
      expect(new Set(refs).size).toBe(refs.length);
    }
  });

  it('keeps each request small', async () => {
    for (const name of ['Arisha.pdf', 'Eleanor.pdf']) {
      const characters = collectAdjudicationCases(await traceOf(cv(name)))
        .flatMap((item) => item.context)
        .join('\n').length;
      expect(characters).toBeLessThan(3_000);
    }
  });
});
