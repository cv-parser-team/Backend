import { DocumentBlock } from './parsing.types.js';

// Reads the small, well-formed HTML that mammoth produces from a Word file:
// headings, paragraphs, list items, bold and italic text, links, and tables. Tables keep
// their rows and cells, and their column headings when Word marks a header row.

const TOKEN = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
const HEADING_TAG = /^h[1-6]$/;
const TEXT_BLOCK_TAGS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BOLD_TAGS = new Set(['strong', 'b']);
const ITALIC_TAGS = new Set(['em', 'i']);

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface TextBuffer {
  text: string;
  boldLength: number;
  italicLength: number;
  heading: boolean;
  links: string[];
}

interface TableBuffer {
  rows: string[][];
  headerRows: boolean[];
  row: string[] | null;
  rowIsHeader: boolean;
  cell: string[] | null;
}

export function readDocxHtml(html: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let paragraph: TextBuffer | null = null;
  let table: TableBuffer | null = null;
  let tableDepth = 0;
  let boldDepth = 0;
  let italicDepth = 0;

  const addBlock = (block: DocumentBlock) => {
    blocks.push({ ...block, index: blocks.length });
  };
  const flushParagraph = () => {
    if (!paragraph) {
      return;
    }
    const text = normalizeSpace(paragraph.text);
    if (text.length > 0) {
      addBlock({
        type: 'paragraph',
        index: 0,
        text,
        heading: paragraph.heading,
        bold: paragraph.boldLength * 2 > text.length,
        italic: paragraph.italicLength * 2 > text.length,
        links: paragraph.links
      });
    }
    paragraph = null;
  };

  for (const match of html.matchAll(TOKEN)) {
    const [, closing, rawTag, attributes, rawText] = match;

    if (rawText !== undefined) {
      const text = decodeEntities(rawText);
      if (table?.cell) {
        table.cell.push(text);
      } else if (paragraph) {
        paragraph.text += text;
        if (boldDepth > 0) {
          paragraph.boldLength += normalizeSpace(text).length;
        }
        if (italicDepth > 0) {
          paragraph.italicLength += normalizeSpace(text).length;
        }
      }
      continue;
    }

    const tag = rawTag!.toLowerCase();
    const isClosing = closing === '/';

    if (tag === 'table') {
      tableDepth += isClosing ? -1 : 1;
      if (!isClosing && tableDepth === 1) {
        flushParagraph();
        table = { rows: [], headerRows: [], row: null, rowIsHeader: false, cell: null };
      } else if (isClosing && tableDepth === 0 && table) {
        const rows = table.rows;
        const hasHeader = rows.length > 1 && table.headerRows[0] === true;
        addBlock({
          type: 'table',
          index: 0,
          columns: hasHeader ? rows[0]! : null,
          rows: hasHeader ? rows.slice(1) : rows
        });
        table = null;
      }
      continue;
    }

    // Nested tables are read as text of the outer cell.
    if (table && tableDepth === 1) {
      if (tag === 'tr') {
        if (!isClosing) {
          table.row = [];
          table.rowIsHeader = true;
        } else if (table.row) {
          table.rows.push(table.row);
          table.headerRows.push(table.rowIsHeader && table.row.length > 0);
          table.row = null;
        }
        continue;
      }
      if (tag === 'td' || tag === 'th') {
        if (!isClosing) {
          table.cell = [];
          if (tag === 'td') {
            table.rowIsHeader = false;
          }
        } else if (table.cell && table.row) {
          table.row.push(normalizeSpace(table.cell.join(' ')));
          table.cell = null;
        }
        continue;
      }
    }
    if (table?.cell) {
      if (TEXT_BLOCK_TAGS.has(tag) || tag === 'br') {
        table.cell.push(' ');
      }
      continue;
    }

    if (BOLD_TAGS.has(tag)) {
      boldDepth = Math.max(0, boldDepth + (isClosing ? -1 : 1));
    } else if (ITALIC_TAGS.has(tag)) {
      italicDepth = Math.max(0, italicDepth + (isClosing ? -1 : 1));
    } else if (tag === 'br' && paragraph) {
      paragraph.text += ' ';
    } else if (tag === 'a' && !isClosing && paragraph) {
      const href = /href="([^"]*)"/.exec(attributes ?? '')?.[1];
      if (href) {
        paragraph.links.push(decodeEntities(href));
      }
    } else if (TEXT_BLOCK_TAGS.has(tag)) {
      // A block that opens inside another, such as a nested list item, ends
      // the outer one first so its text is kept.
      flushParagraph();
      if (!isClosing) {
        paragraph = { text: '', boldLength: 0, italicLength: 0, heading: HEADING_TAG.test(tag), links: [] };
      }
    } else if (tag === 'ul' || tag === 'ol') {
      flushParagraph();
    }
  }
  flushParagraph();

  return blocks;
}
