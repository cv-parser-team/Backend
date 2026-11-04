import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { readDocxHtml } from './docx-html.js';
import { hasTooMuchArabic, removeArabic } from './language.js';
import {
  DocumentBlock,
  DocumentParser,
  ExtractionFailure,
  ExtractionResult
} from './parsing.types.js';

const { version } = createRequire(import.meta.url)('mammoth/package.json') as {
  version: string;
};
const parserVersion = `mammoth@${version}`;

function failedResult(code: ExtractionFailure['code']): ExtractionResult {
  return {
    status: 'failed',
    format: 'docx',
    pageCount: null,
    pages: [],
    blocks: [],
    failures: [{ pageNumber: null, code }],
    parserVersion
  };
}

function blockTexts(block: DocumentBlock): string[] {
  return block.type === 'paragraph'
    ? [block.text]
    : [...(block.columns ?? []), ...block.rows.flat()];
}

function clean(text: string): string {
  return removeArabic(text).replace(/\s+/g, ' ').trim();
}

// Removes small Arabic fragments and drops blocks left without text.
function withoutArabic(blocks: DocumentBlock[]): DocumentBlock[] {
  const kept = blocks.flatMap((block): DocumentBlock[] => {
    if (block.type === 'paragraph') {
      const text = clean(block.text);
      return text.length > 0 ? [{ ...block, text }] : [];
    }
    const rows = block.rows
      .map((row) => row.map(clean))
      .filter((row) => row.some((cell) => cell.length > 0));
    return rows.length > 0 ? [{ ...block, columns: block.columns?.map(clean) ?? null, rows }] : [];
  });
  return kept.map((block, index) => ({ ...block, index }));
}

export function createDocxParser(): DocumentParser {
  return {
    format: 'docx',
    mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],

    async parse(content) {
      let html: string;
      try {
        const result = await mammoth.convertToHtml({ buffer: Buffer.from(content) });
        html = result.value;
      } catch {
        return failedResult('UNREADABLE');
      }

      const blocks = readDocxHtml(html);
      const texts = blocks.flatMap(blockTexts).filter((text) => text.trim().length > 0);

      if (texts.length === 0) {
        return failedResult('NO_TEXT_LAYER');
      }
      if (hasTooMuchArabic(texts)) {
        return failedResult('UNSUPPORTED_LANGUAGE');
      }

      const kept = withoutArabic(blocks);
      if (kept.length === 0) {
        return failedResult('NO_TEXT_LAYER');
      }

      return {
        status: 'succeeded',
        format: 'docx',
        pageCount: null,
        pages: [],
        blocks: kept,
        failures: [],
        parserVersion
      };
    }
  };
}
