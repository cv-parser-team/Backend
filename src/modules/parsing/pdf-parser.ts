import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  getDocument,
  PasswordException,
  VerbosityLevel,
  version
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { hasTooMuchArabic, removeArabic } from './language.js';
import {
  BoundingBox,
  DocumentParser,
  ExtractionFailure,
  ExtractionResult,
  ParsedPage,
  TextLine,
  TextPiece
} from './parsing.types.js';

export const MAX_PDF_PAGES = 4;

const parserVersion = `pdfjs-dist@${version}`;
// pdfjs requires a forward-slash directory path ending with "/".
const standardFontDataUrl = `${join(
  dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
  'standard_fonts'
).replaceAll('\\', '/')}/`;

type Matrix = number[];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0]! * m2[0]! + m1[2]! * m2[1]!,
    m1[1]! * m2[0]! + m1[3]! * m2[1]!,
    m1[0]! * m2[2]! + m1[2]! * m2[3]!,
    m1[1]! * m2[2]! + m1[3]! * m2[3]!,
    m1[0]! * m2[4]! + m1[2]! * m2[5]! + m1[4]!,
    m1[1]! * m2[4]! + m1[3]! * m2[5]! + m1[5]!
  ];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isTextItem(item: object): item is TextItem {
  return 'str' in item && 'transform' in item;
}

// Converts a text item from PDF space (bottom-left origin) to page space
// (top-left origin) using the page viewport.
function toPiece(item: TextItem, viewportTransform: Matrix): TextPiece {
  const matrix = multiply(viewportTransform, item.transform);
  const fontHeight = Math.hypot(matrix[2]!, matrix[3]!);
  const height = item.height > 0 ? item.height : fontHeight;
  return {
    text: item.str,
    box: {
      x: round(matrix[4]!),
      y: round(matrix[5]! - height),
      width: round(item.width),
      height: round(height)
    }
  };
}

function unionBox(boxes: BoundingBox[]): BoundingBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

function toLine(pieces: TextPiece[]): TextLine {
  let text = '';
  pieces.forEach((piece, index) => {
    const previous = pieces[index - 1];
    if (previous) {
      const gap = piece.box.x - (previous.box.x + previous.box.width);
      const needsSpace = gap > piece.box.height * 0.15 && !text.endsWith(' ') && !piece.text.startsWith(' ');
      text += needsSpace ? ' ' : '';
    }
    text += piece.text;
  });
  return { text: text.trim(), box: unionBox(pieces.map((piece) => piece.box)), pieces };
}

// Pieces at the same height form a row. A wide horizontal gap splits a row
// into separate lines, so columns side by side are not merged.
function groupLines(pieces: TextPiece[]): TextLine[] {
  const sorted = [...pieces].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: TextPiece[][] = [];

  for (const piece of sorted) {
    const row = rows[rows.length - 1];
    const anchor = row?.[0];
    const sameRow =
      anchor !== undefined &&
      Math.abs(anchor.box.y + anchor.box.height / 2 - (piece.box.y + piece.box.height / 2)) <=
        Math.min(anchor.box.height, piece.box.height) / 2;
    if (row && sameRow) {
      row.push(piece);
    } else {
      rows.push([piece]);
    }
  }

  return rows.flatMap((row) => {
    const ordered = row.sort((a, b) => a.box.x - b.box.x);
    const lines: TextPiece[][] = [[ordered[0]!]];
    for (const piece of ordered.slice(1)) {
      const current = lines[lines.length - 1]!;
      const previous = current[current.length - 1]!;
      const gap = piece.box.x - (previous.box.x + previous.box.width);
      if (gap > Math.max(previous.box.height, piece.box.height) * 2) {
        lines.push([piece]);
      } else {
        current.push(piece);
      }
    }
    return lines.map(toLine);
  });
}

function failedResult(
  code: ExtractionFailure['code'],
  pageCount: number | null
): ExtractionResult {
  return {
    status: 'failed',
    format: 'pdf',
    pageCount,
    pages: [],
    paragraphs: [],
    failures: [{ pageNumber: null, code }],
    parserVersion
  };
}

export function createPdfParser(): DocumentParser {
  return {
    format: 'pdf',
    mediaTypes: ['application/pdf'],

    async parse(content) {
      const task = getDocument({
        data: new Uint8Array(content),
        standardFontDataUrl,
        verbosity: VerbosityLevel.ERRORS
      });

      try {
        let pdf;
        try {
          pdf = await task.promise;
        } catch (error) {
          return failedResult(
            error instanceof PasswordException ? 'PASSWORD_PROTECTED' : 'UNREADABLE',
            null
          );
        }

        if (pdf.numPages > MAX_PDF_PAGES) {
          return failedResult('TOO_MANY_PAGES', pdf.numPages);
        }

        const readPages: (Omit<ParsedPage, 'lines'> & { pieces: TextPiece[] })[] = [];
        const failures: ExtractionFailure[] = [];

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          try {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const textContent = await page.getTextContent();
            const pieces = textContent.items
              .filter(isTextItem)
              .filter((item) => item.str.trim().length > 0)
              .map((item) => toPiece(item, viewport.transform));

            if (pieces.length === 0) {
              failures.push({ pageNumber, code: 'NO_TEXT_LAYER' });
              continue;
            }

            readPages.push({
              pageNumber,
              width: round(viewport.width),
              height: round(viewport.height),
              pieces
            });
          } catch {
            failures.push({ pageNumber, code: 'PAGE_UNREADABLE' });
          }
        }

        // The language is checked across the whole file before lines are built.
        if (hasTooMuchArabic(readPages.flatMap((page) => page.pieces.map((piece) => piece.text)))) {
          return failedResult('UNSUPPORTED_LANGUAGE', pdf.numPages);
        }

        const pages: ParsedPage[] = [];
        for (const { pieces, ...page } of readPages) {
          const kept = pieces
            .map((piece) => ({ ...piece, text: removeArabic(piece.text) }))
            .filter((piece) => piece.text.trim().length > 0);

          if (kept.length === 0) {
            failures.push({ pageNumber: page.pageNumber, code: 'NO_TEXT_LAYER' });
            continue;
          }
          pages.push({ ...page, lines: groupLines(kept) });
        }
        failures.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0));

        return {
          status: failures.length === 0 ? 'succeeded' : pages.length > 0 ? 'partial' : 'failed',
          format: 'pdf',
          pageCount: pdf.numPages,
          pages,
          paragraphs: [],
          failures,
          parserVersion
        };
      } finally {
        await task.destroy();
      }
    }
  };
}
