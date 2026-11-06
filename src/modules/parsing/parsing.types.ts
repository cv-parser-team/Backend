export type DocumentFormat = 'pdf' | 'docx';

export type ExtractionStatus = 'succeeded' | 'partial' | 'failed';

// File-level codes fail the whole extraction; page-level codes fail one page.
export type ParseErrorCode =
  | 'UNREADABLE'
  | 'PASSWORD_PROTECTED'
  | 'TOO_MANY_PAGES'
  | 'UNSUPPORTED_LANGUAGE'
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

// A thin axis-aligned shape drawn on a PDF page. Separators are extraction
// evidence only until a later layout stage decides whether they support a
// boundary.
export interface DrawnSeparator {
  orientation: 'horizontal' | 'vertical';
  box: BoundingBox;
  thickness: number;
}

// A piece of text as the file stores it; used to build lines, not stored.
export interface TextPiece {
  text: string;
  box: BoundingBox;
  bold: boolean;
  italic: boolean;
  // Link targets placed over the piece, such as a LinkedIn profile.
  links: string[];
}

export interface TextLine {
  // Reading order across the whole document; unique, starting at 1.
  order: number;
  text: string;
  box: BoundingBox;
  // Set from a larger font than body text; used to find sections.
  heading: boolean;
  // Set from the font name. Bold body-size text is not treated as a heading,
  // because it can also be a job title or a company name.
  bold: boolean;
  // Set from the font name when most characters are slanted, such as a
  // company name set in italics under a job title.
  italic: boolean;
  // Set when the line starts a list item: it starts with a bullet character,
  // or a small mark, such as a drawn dot, sits just before it.
  bullet: boolean;
  // Link targets in the line, often hidden behind text such as "LinkedIn".
  links: string[];
}

export interface Region {
  index: number;
  box: BoundingBox;
  // Score of the boundary that created the region; null when not split.
  confidence: number | null;
  lines: TextLine[];
}

export interface ParsedPage {
  pageNumber: number;
  width: number;
  height: number;
  regions: Region[];
}

// DOCX files have no fixed pages, so their text is kept as ordered blocks.
export interface ParagraphBlock {
  type: 'paragraph';
  index: number;
  text: string;
  // Set from Word heading styles.
  heading: boolean;
  // Set when most characters are bold or italic.
  bold: boolean;
  italic: boolean;
  // Link targets in the paragraph, such as a LinkedIn profile.
  links: string[];
}

export interface TableBlock {
  type: 'table';
  index: number;
  // Column headings, only when the author marked a header row in Word.
  columns: string[] | null;
  rows: string[][];
}

export type DocumentBlock = ParagraphBlock | TableBlock;

export interface ExtractionFailure {
  pageNumber: number | null;
  code: ParseErrorCode;
}

export interface ExtractionResult {
  status: ExtractionStatus;
  format: DocumentFormat;
  pageCount: number | null;
  pages: ParsedPage[];
  blocks: DocumentBlock[];
  failures: ExtractionFailure[];
  parserVersion: string;
}

export interface DocumentParser {
  format: DocumentFormat;
  mediaTypes: readonly string[];
  parse(content: Uint8Array): Promise<ExtractionResult>;
}
