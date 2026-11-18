import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  getDocument,
  OPS,
  PasswordException,
  VerbosityLevel,
  version
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  PDFDocumentLoadingTask,
  PDFPageProxy,
  TextItem
} from 'pdfjs-dist/types/src/display/api.js';
import { hasTooMuchArabic, removeArabic } from './language.js';
import {
  buildPages,
  buildPagesWithTrace,
  type LayoutAdjudications,
  type LayoutTrace,
  PositionedPage,
  round,
  SPACED_LETTERS
} from './layout.js';
import {
  BoundingBox,
  DocumentParser,
  DrawnSeparator,
  ExtractionFailure,
  ExtractionResult,
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

function toPagePoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
}

function isTextItem(item: object): item is TextItem {
  return 'str' in item && 'transform' in item;
}

// Weight and slant words in font names, such as "Calibri-Bold", "Lato-Black",
// or "Montserrat-MediumItalic".
const BOLD_FONT_NAME = /bold|black|heavy|semibold|demibold/i;
const ITALIC_FONT_NAME = /italic|oblique/i;
// Short forms, such as "CenturyGothic-Bd", "Minion-BoldIt", or "MyriadPro-It",
// are read only in the style after the last "-" or ",", so they never match
// inside a family name.
const BOLD_STYLE = /^(bd|blk|hvy?|semibd|xbd|extrabd)(it)?$/i;
const ITALIC_STYLE = /(it|obl)$/i;

interface FontStyle {
  bold: boolean;
  italic: boolean;
}

// Font names are only available after the page's operator list is loaded.
// Fonts without a weight or slant in their name, or drawn bold or slanted by
// other means, read as regular.
function fontStyle(page: PDFPageProxy, fontName: string): FontStyle {
  const font: unknown = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
  const name =
    typeof font === 'object' && font !== null && 'name' in font && typeof font.name === 'string'
      ? font.name
      : '';
  const separator = Math.max(name.lastIndexOf('-'), name.lastIndexOf(','));
  const style = separator >= 0 ? name.slice(separator + 1) : '';
  return {
    bold: BOLD_FONT_NAME.test(name) || BOLD_STYLE.test(style),
    italic: ITALIC_FONT_NAME.test(name) || ITALIC_STYLE.test(style)
  };
}

interface OperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

// The page text in drawing order, glyph by glyph. Unlike text extraction, it
// keeps the real spaces of text whose letters are spaced out.
function drawnText(operators: OperatorList): string {
  let text = '';
  operators.fnArray.forEach((fn, index) => {
    const args = operators.argsArray[index];
    if (fn !== OPS.showText || !Array.isArray(args) || !Array.isArray(args[0])) {
      return;
    }
    for (const glyph of args[0] as unknown[]) {
      if (typeof glyph === 'object' && glyph !== null && 'unicode' in glyph && typeof glyph.unicode === 'string') {
        text += glyph.unicode;
      }
    }
  });
  return text;
}

// Shapes up to this size, in points, may be list bullets drawn as dots.
const MAX_MARK_SIZE = 10;
const MIN_SEPARATOR_LENGTH = 20;
const MAX_SEPARATOR_THICKNESS = 3;

// Operator arguments come as plain or typed number arrays.
function toNumbers(value: unknown, length: number): number[] | null {
  if (typeof value !== 'object' || value === null || !('length' in value) || value.length !== length) {
    return null;
  }
  const numbers = Array.from(value as ArrayLike<unknown>);
  return numbers.every((item) => typeof item === 'number') ? (numbers as number[]) : null;
}

export interface DrawnPrimitives {
  marks: BoundingBox[];
  separators: DrawnSeparator[];
}

interface DrawingState {
  transform: Matrix;
  lineWidth: number;
}

interface PendingPath {
  box: BoundingBox;
  lineWidth: number;
}

const STROKE_OPERATORS = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fillStroke,
  OPS.eoFillStroke
]);
const FILL_OPERATORS = new Set<number>([
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke
]);
const PAINT_OPERATORS = new Set<number>([...STROKE_OPERATORS, ...FILL_OPERATORS]);

function transformedBox(corners: number[], transform: Matrix): BoundingBox {
  const [x1, y1, x2, y2] = corners;
  const points = [
    toPagePoint(transform, x1!, y1!),
    toPagePoint(transform, x1!, y2!),
    toPagePoint(transform, x2!, y1!),
    toPagePoint(transform, x2!, y2!)
  ];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: round(left),
    y: round(top),
    width: round(Math.max(...xs) - left),
    height: round(Math.max(...ys) - top)
  };
}

function transformedLineWidth(transform: Matrix, lineWidth: number): number {
  const scale = Math.max(
    Math.hypot(transform[0]!, transform[1]!),
    Math.hypot(transform[2]!, transform[3]!)
  );
  // PDF hairlines have a width of zero and render at the thinnest visible
  // device width. One page point keeps them visible in the inspection trace.
  return Math.max(1, round(lineWidth * scale));
}

function withStrokeThickness(box: BoundingBox, thickness: number): BoundingBox {
  if (box.height === 0 && box.width > 0) {
    return { ...box, y: round(box.y - thickness / 2), height: thickness };
  }
  if (box.width === 0 && box.height > 0) {
    return { ...box, x: round(box.x - thickness / 2), width: thickness };
  }
  return box;
}

function separatorFromPath(path: PendingPath, stroked: boolean): DrawnSeparator | null {
  const box = stroked ? withStrokeThickness(path.box, path.lineWidth) : path.box;
  const horizontal =
    box.width >= MIN_SEPARATOR_LENGTH &&
    box.height > 0 &&
    box.height <= MAX_SEPARATOR_THICKNESS;
  const vertical =
    box.height >= MIN_SEPARATOR_LENGTH &&
    box.width > 0 &&
    box.width <= MAX_SEPARATOR_THICKNESS;

  if (!horizontal && !vertical) {
    return null;
  }
  const orientation = horizontal ? 'horizontal' : 'vertical';
  return {
    orientation,
    box,
    thickness: orientation === 'horizontal' ? box.height : box.width
  };
}

function overlapShare(first: DrawnSeparator, second: DrawnSeparator): number {
  if (first.orientation !== second.orientation) {
    return 0;
  }
  const horizontal = first.orientation === 'horizontal';
  const firstStart = horizontal ? first.box.x : first.box.y;
  const firstEnd = firstStart + (horizontal ? first.box.width : first.box.height);
  const secondStart = horizontal ? second.box.x : second.box.y;
  const secondEnd = secondStart + (horizontal ? second.box.width : second.box.height);
  const overlap = Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
  return overlap / Math.min(firstEnd - firstStart, secondEnd - secondStart);
}

function sameSeparatorLane(first: DrawnSeparator, second: DrawnSeparator): boolean {
  const firstCenter = first.orientation === 'horizontal'
    ? first.box.y + first.box.height / 2
    : first.box.x + first.box.width / 2;
  const secondCenter = second.orientation === 'horizontal'
    ? second.box.y + second.box.height / 2
    : second.box.x + second.box.width / 2;
  return Math.abs(firstCenter - secondCenter) <= Math.max(first.thickness, second.thickness);
}

function addSeparator(separators: DrawnSeparator[], separator: DrawnSeparator): void {
  const duplicate = separators.some(
    (existing) => sameSeparatorLane(existing, separator) && overlapShare(existing, separator) >= 0.9
  );
  if (!duplicate) {
    separators.push(separator);
  }
}

// Drawn primitives in page space. Shapes are drawn in their own coordinates,
// so the drawing transform and stroke width are followed through saved states
// and embedded forms. Thin rules remain inert extraction evidence in Stage 1.
export function extractDrawnPrimitives(
  operators: OperatorList,
  viewportTransform: Matrix
): DrawnPrimitives {
  const marks: BoundingBox[] = [];
  const separators: DrawnSeparator[] = [];
  const saved: DrawingState[] = [];
  const pendingPaths: PendingPath[] = [];
  let state: DrawingState = { transform: [1, 0, 0, 1, 0, 0], lineWidth: 1 };

  const finishPaths = (stroked: boolean, filled: boolean) => {
    for (const path of pendingPaths) {
      const separator = separatorFromPath(path, stroked);
      if (separator) {
        addSeparator(separators, separator);
      }
      const box = stroked ? withStrokeThickness(path.box, path.lineWidth) : path.box;
      if (
        (stroked || filled) &&
        box.width > 0 &&
        box.height > 0 &&
        box.width <= MAX_MARK_SIZE &&
        box.height <= MAX_MARK_SIZE
      ) {
        marks.push(box);
      }
    }
    pendingPaths.length = 0;
  };

  operators.fnArray.forEach((fn, index) => {
    const args = operators.argsArray[index];
    if (fn === OPS.save) {
      saved.push({ transform: state.transform, lineWidth: state.lineWidth });
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      state = saved.pop() ?? state;
    } else if (fn === OPS.transform) {
      const matrix = toNumbers(args, 6);
      state = matrix ? { ...state, transform: multiply(state.transform, matrix) } : state;
    } else if (fn === OPS.setLineWidth) {
      const values = toNumbers(args, 1);
      state = values ? { ...state, lineWidth: values[0]! } : state;
    } else if (fn === OPS.paintFormXObjectBegin) {
      saved.push({ transform: state.transform, lineWidth: state.lineWidth });
      const formMatrix = toNumbers(Array.isArray(args) ? args[0] : null, 6);
      state = formMatrix
        ? { ...state, transform: multiply(state.transform, formMatrix) }
        : state;
    } else if (fn === OPS.constructPath && Array.isArray(args)) {
      const corners = toNumbers(args.at(-1), 4);
      if (!corners) {
        return;
      }
      const toPage = multiply(viewportTransform, state.transform);
      pendingPaths.push({
        box: transformedBox(corners, toPage),
        lineWidth: transformedLineWidth(toPage, state.lineWidth)
      });
      // pdfjs normally folds the paint operation into constructPath as its
      // first argument. Keep support for a following paint operator as well,
      // which makes the extractor tolerant of uncombined operator lists.
      const pathPaint = typeof args[0] === 'number' ? args[0] : null;
      if (pathPaint !== null && PAINT_OPERATORS.has(pathPaint)) {
        finishPaths(STROKE_OPERATORS.has(pathPaint), FILL_OPERATORS.has(pathPaint));
      }
    } else if (PAINT_OPERATORS.has(fn)) {
      finishPaths(STROKE_OPERATORS.has(fn), FILL_OPERATORS.has(fn));
    } else if (fn === OPS.endPath) {
      pendingPaths.length = 0;
    }
  });
  return { marks, separators };
}

// Text extraction puts a space between every spaced-out letter, so
// "ABOUT ME" reads "A B O U T M E". The drawn text has the same letters with
// the real word breaks.
function withDrawnSpacing(text: string, drawn: string): string {
  if (!SPACED_LETTERS.test(text)) {
    return text;
  }
  const letters = text.replaceAll(' ', '');
  const positions: number[] = [];
  let compact = '';
  for (let index = 0; index < drawn.length; index++) {
    if (drawn[index]!.trim() !== '') {
      positions.push(index);
      compact += drawn[index];
    }
  }
  const start = compact.indexOf(letters);
  if (start < 0) {
    return text;
  }
  return drawn
    .slice(positions[start], positions[start + letters.length - 1]! + 1)
    .replace(/\s+/g, ' ');
}

interface PageLink {
  url: string;
  box: BoundingBox;
}

function isUrlLink(annotation: unknown): annotation is { url: string; rect: number[] } {
  return (
    typeof annotation === 'object' &&
    annotation !== null &&
    'subtype' in annotation &&
    annotation.subtype === 'Link' &&
    'url' in annotation &&
    typeof annotation.url === 'string' &&
    'rect' in annotation &&
    Array.isArray(annotation.rect) &&
    annotation.rect.length === 4
  );
}

// Link targets are stored apart from the text, as clickable rectangles.
async function readLinks(page: PDFPageProxy, viewportTransform: Matrix): Promise<PageLink[]> {
  const annotations: unknown[] = await page.getAnnotations();
  return annotations.filter(isUrlLink).map(({ url, rect }) => {
    const [x1, y1, x2, y2] = rect.map(Number);
    const [left, top] = toPagePoint(viewportTransform, x1!, y1!);
    const [right, bottom] = toPagePoint(viewportTransform, x2!, y2!);
    return {
      url,
      box: {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        width: Math.abs(right - left),
        height: Math.abs(bottom - top)
      }
    };
  });
}

// A link belongs to a piece when its rectangle covers part of the piece's
// width and most of its height.
function linksOver(box: BoundingBox, links: PageLink[]): string[] {
  return links
    .filter((link) => {
      const width = Math.min(box.x + box.width, link.box.x + link.box.width) - Math.max(box.x, link.box.x);
      const height = Math.min(box.y + box.height, link.box.y + link.box.height) - Math.max(box.y, link.box.y);
      return width > 0 && height >= Math.min(box.height, link.box.height) / 2;
    })
    .sort((a, b) => a.box.x - b.box.x)
    .map((link) => link.url);
}

// Converts a text item from PDF space (bottom-left origin) to page space
// (top-left origin) using the page viewport.
function toPiece(item: TextItem, viewportTransform: Matrix, style: FontStyle, links: PageLink[]): TextPiece {
  const matrix = multiply(viewportTransform, item.transform);
  const fontHeight = Math.hypot(matrix[2]!, matrix[3]!);
  const height = item.height > 0 ? item.height : fontHeight;
  const box = {
    x: round(matrix[4]!),
    y: round(matrix[5]! - height),
    width: round(item.width),
    height: round(height)
  };
  return { text: item.str, box, ...style, links: linksOver(box, links) };
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
    blocks: [],
    failures: [{ pageNumber: null, code }],
    parserVersion
  };
}

export interface PdfParserOptions {
  onLayoutTrace?: (trace: LayoutTrace) => void;
  // AI decisions about uncertain roles, applied when building the trace.
  adjudications?: LayoutAdjudications;
}

export function createPdfParser(options: PdfParserOptions = {}): DocumentParser {
  return {
    format: 'pdf',
    mediaTypes: ['application/pdf'],

    async parse(content) {
      let task: PDFDocumentLoadingTask;
      try {
        task = getDocument({
          data: new Uint8Array(content),
          standardFontDataUrl,
          fontExtraProperties: true,
          verbosity: VerbosityLevel.ERRORS
        });
      } catch {
        return failedResult('UNREADABLE', null);
      }
      let pageCount: number | null = null;

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
        pageCount = pdf.numPages;

        if (pdf.numPages > MAX_PDF_PAGES) {
          return failedResult('TOO_MANY_PAGES', pdf.numPages);
        }

        const readPages: PositionedPage[] = [];
        const failures: ExtractionFailure[] = [];

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          try {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const textContent = await page.getTextContent();
            const operators = await page.getOperatorList();
            const drawn = drawnText(operators);
            const links = await readLinks(page, viewport.transform);
            const pieces = textContent.items
              .filter(isTextItem)
              .filter((item) => item.str.trim().length > 0)
              .map((item) => ({
                ...toPiece(item, viewport.transform, fontStyle(page, item.fontName), links),
                text: withDrawnSpacing(item.str, drawn)
              }));

            if (pieces.length === 0) {
              failures.push({ pageNumber, code: 'NO_TEXT_LAYER' });
              continue;
            }

            const primitives = extractDrawnPrimitives(operators, viewport.transform);

            readPages.push({
              pageNumber,
              width: round(viewport.width),
              height: round(viewport.height),
              pieces,
              ...primitives
            });
          } catch {
            failures.push({ pageNumber, code: 'PAGE_UNREADABLE' });
          }
        }

        // The language is checked across the whole file before lines are built.
        if (hasTooMuchArabic(readPages.flatMap((page) => page.pieces.map((piece) => piece.text)))) {
          return failedResult('UNSUPPORTED_LANGUAGE', pdf.numPages);
        }

        const keptPages: PositionedPage[] = [];
        for (const page of readPages) {
          const pieces: TextPiece[] = page.pieces
            .map((piece) => ({ ...piece, text: removeArabic(piece.text) }))
            .filter((piece) => piece.text.trim().length > 0);

          if (pieces.length === 0) {
            failures.push({ pageNumber: page.pageNumber, code: 'NO_TEXT_LAYER' });
            continue;
          }
          keptPages.push({ ...page, pieces });
        }
        failures.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0));
        let pages;
        if (options.onLayoutTrace) {
          const built = buildPagesWithTrace(keptPages, options.adjudications);
          options.onLayoutTrace(built.trace);
          pages = built.pages;
        } else {
          pages = buildPages(keptPages);
        }

        return {
          status: failures.length === 0 ? 'succeeded' : pages.length > 0 ? 'partial' : 'failed',
          format: 'pdf',
          pageCount: pdf.numPages,
          pages,
          blocks: [],
          failures,
          parserVersion
        };
      } catch {
        return failedResult('UNREADABLE', pageCount);
      } finally {
        try {
          await task.destroy();
        } catch {}
      }
    }
  };
}
