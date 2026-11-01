export type DocumentFormat = 'pdf' | 'docx';

export type ExtractionStatus = 'succeeded' | 'partial' | 'failed';

// File-level codes fail the whole extraction; page-level codes fail one page.
export type ParseErrorCode =
  | 'UNREADABLE'
  | 'PASSWORD_PROTECTED'
  | 'TOO_MANY_PAGES'
  | 'NO_TEXT_LAYER'
  | 'PAGE_UNREADABLE';

export interface ParseInput {
  content: Uint8Array;
  mediaType: string;
}

// Measured in PDF points from the page's top-left corner.
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextPiece {
  text: string;
  box: BoundingBox;
}

export interface TextLine {
  text: string;
  box: BoundingBox;
  pieces: TextPiece[];
}

export interface ParsedPage {
  pageNumber: number;
  width: number;
  height: number;
  lines: TextLine[];
}

// DOCX files have no fixed pages, so their text is kept as ordered paragraphs.
export interface ParsedParagraph {
  index: number;
  text: string;
}

export interface ExtractionFailure {
  pageNumber: number | null;
  code: ParseErrorCode;
}

export interface ExtractionResult {
  status: ExtractionStatus;
  format: DocumentFormat;
  pageCount: number | null;
  pages: ParsedPage[];
  paragraphs: ParsedParagraph[];
  failures: ExtractionFailure[];
  parserVersion: string;
}

export interface DocumentParser {
  format: DocumentFormat;
  mediaTypes: readonly string[];
  parse(content: Uint8Array): Promise<ExtractionResult>;
}
