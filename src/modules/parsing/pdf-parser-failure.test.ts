import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./layout.js', async (importOriginal) => {
  const layout = await importOriginal<typeof import('./layout.js')>();
  return {
    ...layout,
    buildPages: () => {
      throw new Error('synthetic layout failure');
    }
  };
});

import { createPdfParser } from './pdf-parser.js';

describe('PDF parser failure containment', () => {
  it('returns a failed extraction when layout resolution throws', async () => {
    const content = await readFile(
      new URL('./__fixtures__/single-page.pdf', import.meta.url)
    );
    const result = await createPdfParser().parse(new Uint8Array(content));

    expect(result).toMatchObject({
      status: 'failed',
      pageCount: 1,
      pages: [],
      failures: [{ pageNumber: null, code: 'UNREADABLE' }]
    });
  });
});
