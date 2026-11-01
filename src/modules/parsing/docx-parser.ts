import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import {
  DocumentParser,
  ExtractionFailure,
  ExtractionResult,
  ParsedParagraph
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
    paragraphs: [],
    failures: [{ pageNumber: null, code }],
    parserVersion
  };
}

export function createDocxParser(): DocumentParser {
  return {
    format: 'docx',
    mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],

    async parse(content) {
      let text: string;
      try {
        const result = await mammoth.extractRawText({ buffer: Buffer.from(content) });
        text = result.value;
      } catch {
        return failedResult('UNREADABLE');
      }

      // Each paragraph and table cell is a separate line in the raw text.
      const paragraphs: ParsedParagraph[] = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => ({ index, text: line }));

      if (paragraphs.length === 0) {
        return failedResult('NO_TEXT_LAYER');
      }

      return {
        status: 'succeeded',
        format: 'docx',
        pageCount: null,
        pages: [],
        paragraphs,
        failures: [],
        parserVersion
      };
    }
  };
}
