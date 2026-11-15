import type {
  BoundingBox,
  DocumentBlock,
  ExtractionResult,
  ParsedPage,
  TextLine
} from './parsing.types.js';

export interface PdfLineSourceAnchor {
  kind: 'pdf_line';
  order: number;
  pageNumber: number;
  box: BoundingBox;
  text: string;
  links: string[];
}

export interface DocxParagraphSourceAnchor {
  kind: 'docx_paragraph';
  blockIndex: number;
  text: string;
  links: string[];
}

export interface DocxTableRowSourceAnchor {
  kind: 'docx_table_row';
  blockIndex: number;
  rowNumber: number;
  cells: string[];
}

export type PhysicalSourceAnchor =
  | PdfLineSourceAnchor
  | DocxParagraphSourceAnchor
  | DocxTableRowSourceAnchor;

export interface ResolvedSourceReference {
  reference: string;
  anchors: PhysicalSourceAnchor[];
}

export interface SourceReferenceResolution {
  resolved: ResolvedSourceReference[];
  missing: string[];
  ambiguous: string[];
}

type PdfLineLocation = { page: ParsedPage; line: TextLine };

function addToIndex<T>(index: Map<number, T[]>, key: number, value: T): void {
  const values = index.get(key) ?? [];
  values.push(value);
  index.set(key, values);
}

function pdfLineIndex(pages: ParsedPage[]): Map<number, PdfLineLocation[]> {
  const index = new Map<number, PdfLineLocation[]>();
  for (const page of pages) {
    for (const region of page.regions) {
      for (const line of region.lines) {
        addToIndex(index, line.order, { page, line });
      }
    }
  }
  return index;
}

function docxBlockIndex(blocks: DocumentBlock[]): Map<number, DocumentBlock[]> {
  const index = new Map<number, DocumentBlock[]>();
  for (const block of blocks) {
    addToIndex(index, block.index, block);
  }
  return index;
}

function pdfOrders(reference: string, lineCount: number): number[] | null {
  const match = /^L(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(reference);
  if (!match) {
    return null;
  }

  const orders = new Set<number>();
  for (const part of match[1]!.split(',')) {
    const [startText, endText] = part.split('-');
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (start < 1 || end < start || end - start + 1 > lineCount) {
      return null;
    }
    for (let order = start; order <= end; order++) {
      orders.add(order);
    }
  }
  return [...orders];
}

function resolvePdfReference(
  reference: string,
  index: Map<number, PdfLineLocation[]>
): PhysicalSourceAnchor[] | 'missing' | 'ambiguous' | null {
  const lineCount = [...index.values()].reduce(
    (count, locations) => count + locations.length,
    0
  );
  const orders = pdfOrders(reference, lineCount);
  if (orders === null) {
    return reference.startsWith('L') ? 'missing' : null;
  }

  const anchors: PdfLineSourceAnchor[] = [];
  for (const order of orders) {
    const locations = index.get(order) ?? [];
    if (locations.length === 0) {
      return 'missing';
    }
    if (locations.length > 1) {
      return 'ambiguous';
    }
    const { page, line } = locations[0]!;
    anchors.push({
      kind: 'pdf_line',
      order,
      pageNumber: page.pageNumber,
      box: { ...line.box },
      text: line.text,
      links: [...line.links]
    });
  }
  return anchors;
}

function resolveDocxReference(
  reference: string,
  index: Map<number, DocumentBlock[]>
): PhysicalSourceAnchor[] | 'missing' | 'ambiguous' | null {
  const match = /^B(\d+)(?:\.(\d+))?$/.exec(reference);
  if (!match) {
    return reference.startsWith('B') ? 'missing' : null;
  }

  const blockIndex = Number(match[1]);
  const rowNumber = match[2] === undefined ? null : Number(match[2]);
  const blocks = index.get(blockIndex) ?? [];
  if (blocks.length === 0) {
    return 'missing';
  }
  if (blocks.length > 1) {
    return 'ambiguous';
  }

  const block = blocks[0]!;
  if (block.type === 'paragraph' && rowNumber === null) {
    return [
      {
        kind: 'docx_paragraph',
        blockIndex,
        text: block.text,
        links: [...block.links]
      }
    ];
  }
  if (block.type === 'table' && rowNumber !== null) {
    const cells = block.rows[rowNumber - 1];
    return cells
      ? [{ kind: 'docx_table_row', blockIndex, rowNumber, cells: [...cells] }]
      : 'missing';
  }
  return 'missing';
}

// Resolves citation tokens to stored physical evidence only. Heading flags,
// region roles, and other parser-inferred semantics are deliberately excluded.
export function resolveSourceReferences(
  content: Pick<ExtractionResult, 'pages' | 'blocks'>,
  references: readonly string[]
): SourceReferenceResolution {
  const lines = pdfLineIndex(content.pages);
  const blocks = docxBlockIndex(content.blocks);
  const resolution: SourceReferenceResolution = {
    resolved: [],
    missing: [],
    ambiguous: []
  };

  for (const reference of new Set(references)) {
    const result =
      resolvePdfReference(reference, lines) ??
      resolveDocxReference(reference, blocks) ??
      'missing';
    if (result === 'missing' || result === 'ambiguous') {
      resolution[result].push(reference);
    } else {
      resolution.resolved.push({ reference, anchors: result });
    }
  }

  return resolution;
}
