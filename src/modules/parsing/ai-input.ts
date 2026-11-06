import { BULLET, LAYOUT_SETTINGS, SPACED_LETTERS } from './layout.js';
import { DocumentBlock, ExtractionResult, Region, TextLine } from './parsing.types.js';

// Wrapped lines are joined only when every signal agrees, so a wrong guess
// keeps two lines apart instead of mixing two facts.
export const AI_INPUT_SETTINGS = {
  // A gap up to this many usual gaps is normal line spacing.
  wrapGapRatio: 1.5
};

const CONNECTOR_END = /([,;&/–-]|\b(and|or|with|for|the|of|to|in|on|at|a|an|by|from|as|into|using|including))$/i;

// The sentence visibly continues: the next line starts in lowercase or with an
// opening bracket, or the line ends with a comma or a joining word. Short list
// items in a narrow sidebar, such as a phone number above a city, never pass
// this check.
function sentenceContinues(above: TextLine, below: TextLine): boolean {
  return /^[\p{Ll}(]/u.test(below.text) || CONNECTOR_END.test(above.text);
}

// A line wraps only when the next line's first word would not have fitted at
// its end. The available width ends at the widest line sharing the line's
// left edge. Character width is estimated from the line itself.
function nextWordDidNotFit(above: TextLine, below: TextLine, region: Region): boolean {
  const characterWidth = above.box.width / above.text.length;
  const firstWord = below.text.split(' ')[0] ?? '';
  const columnRight = Math.max(
    ...region.lines
      .filter((line) => Math.abs(line.box.x - above.box.x) <= LAYOUT_SETTINGS.alignmentTolerance)
      .map((line) => line.box.x + line.box.width)
  );
  const room = columnRight - (above.box.x + above.box.width);
  return characterWidth * (firstWord.length + 1) > room;
}

const DATE = /^((\d{1,2}[/.-])?\d{4}\b|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4})/i;
// Contact details start a new fact, even when they start in lowercase.
const CONTACT = /^(\S+@\S+|https?:\/\/|www\.|\+?\d[\d ().-]{6,})/i;
// The PDF parser restores word breaks of spaced-out letters when the file
// keeps them; otherwise "A B O U T M E" becomes "ABOUTME".
function withoutLetterSpacing(text: string): string {
  return SPACED_LETTERS.test(text) ? text.replaceAll(' ', '') : text;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function gapBetween(above: TextLine, below: TextLine): number {
  return below.box.y - (above.box.y + above.box.height);
}

function usualGap(regions: Region[]): number {
  const gaps = regions.flatMap((region) =>
    region.lines.slice(1).map((line, index) => gapBetween(region.lines[index]!, line))
  );
  const positive = gaps.filter((gap) => gap >= 0);
  return positive.length > 0 ? median(positive) : 0;
}

// A list item is a bullet line with another bullet nearby in the same column,
// so a lone dot, such as a timeline marker beside a job title, is not a list.
function inList(item: TextLine, region: Region): boolean {
  return region.lines.some(
    (other) =>
      other !== item &&
      other.bullet &&
      Math.abs(other.box.x - item.box.x) <= LAYOUT_SETTINGS.alignmentTolerance &&
      Math.abs(other.box.y - item.box.y) <= item.box.height * 4
  );
}

// A heading too long for one line, such as a name set in large letters,
// continues right below at the same size, starting or centred at the same
// place. Headings are otherwise never joined.
function continuesHeading(above: TextLine, below: TextLine): boolean {
  const tolerance = LAYOUT_SETTINGS.alignmentTolerance;
  const center = (line: TextLine) => line.box.x + line.box.width / 2;
  const lineGap = gapBetween(above, below);
  return (
    above.heading &&
    below.heading &&
    Math.max(above.box.height, below.box.height) / Math.min(above.box.height, below.box.height) < 1.1 &&
    (Math.abs(below.box.x - above.box.x) <= tolerance || Math.abs(center(below) - center(above)) <= tolerance) &&
    lineGap >= -above.box.height / 4 &&
    lineGap <= above.box.height / 2 &&
    !/[.:]$/.test(above.text)
  );
}

// Whether the next line continues the flow: wrapped text, the rest of a list
// item, or the rest of a heading. Every listed signal must agree.
function continuesLine(flow: Flow, below: TextLine, region: Region, gap: number): boolean {
  const item = flow[0]!;
  const above = flow.at(-1)!;
  if (above.heading || below.heading) {
    return continuesHeading(above, below);
  }
  const lineGap = gapBetween(above, below);
  const heights = [above.box.height, below.box.height];
  const aligned = Math.abs(below.box.x - above.box.x) <= LAYOUT_SETTINGS.alignmentTolerance;
  const indentedUnderBullet =
    BULLET.test(above.text) &&
    below.box.x > above.box.x &&
    below.box.x <= above.box.x + 3 * above.box.height;
  // A line without a bullet under a list item, aligned with its text, is the
  // rest of that item, even when nothing in the words shows it.
  const restOfListItem = item.bullet && aligned && inList(item, region);
  const wrappedText =
    (aligned || indentedUnderBullet) &&
    nextWordDidNotFit(above, below, region) &&
    sentenceContinues(above, below);

  return (
    above.bold === below.bold &&
    above.italic === below.italic &&
    Math.max(...heights) / Math.min(...heights) < LAYOUT_SETTINGS.headingHeightRatio &&
    lineGap >= -above.box.height / 4 &&
    lineGap <= gap * AI_INPUT_SETTINGS.wrapGapRatio + 1 &&
    (wrappedText || restOfListItem) &&
    !/[.:]$/.test(above.text) &&
    !below.bullet &&
    !BULLET.test(below.text) &&
    !DATE.test(below.text) &&
    !CONTACT.test(below.text)
  );
}

// Bold text is marked `*text*` and italic text `_text_`, such as a company
// name in italics under a job title. Headings are marked with "##" instead.
function marked(text: string, style: { heading: boolean; bold: boolean; italic: boolean }): string {
  if (style.heading) {
    return text;
  }
  const slanted = style.italic ? `_${text}_` : text;
  return style.bold ? `*${slanted}*` : slanted;
}

// Link targets hidden behind text, such as "LinkedIn", are listed after it;
// links already written in the text are not repeated.
function hiddenLinks(text: string, links: string[]): string {
  const hidden = links.filter((link) => {
    const written = link.replace(/^(mailto:|tel:|https?:\/\/)(www\.)?/i, '').replace(/\/$/, '');
    return !text.includes(written);
  });
  return hidden.length > 0 ? ` (links: ${hidden.join(', ')})` : '';
}

// A flow holds one line, or consecutive lines when text wraps.
type Flow = TextLine[];

// Line references such as "L5", "L5-7", or "L5-6,9" for lines that are not
// next to each other in reading order.
function reference(lines: TextLine[]): string {
  const orders = lines.map((line) => line.order).sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let start = 0; start < orders.length; ) {
    let end = start;
    while (orders[end + 1] === orders[end]! + 1) {
      end++;
    }
    ranges.push(start === end ? `${orders[start]}` : `${orders[start]}-${orders[end]}`);
    start = end + 1;
  }
  return `L${ranges.join(',')}`;
}

// List items drawn with a shape bullet get a bullet character, so AI sees
// where each item starts.
function flowText(flow: Flow): string {
  const text = flow.map((line) => withoutLetterSpacing(line.text)).join(' ');
  const styled = marked(text, flow[0]!);
  return flow[0]!.bullet && !BULLET.test(text) ? `• ${styled}` : styled;
}

function regionFlows(region: Region, gap: number): Flow[] {
  const flows: Flow[] = [];
  for (const line of region.lines) {
    const flow = flows.at(-1);
    if (flow && continuesLine(flow, line, region, gap)) {
      flow.push(line);
    } else {
      flows.push([line]);
    }
  }
  return flows;
}

function regionLines(region: Region, gap: number): string[] {
  return regionFlows(region, gap).map((flow) => {
    const text = flowText(flow);
    const links = hiddenLinks(text, [...new Set(flow.flatMap((line) => line.links))]);
    const heading = flow[0]!.heading ? '## ' : '';
    return `${heading}${reference(flow)} ${text}${links}`;
  });
}

function blockLines(block: DocumentBlock): string[] {
  if (block.type === 'table') {
    const rows = block.rows.map((row, index) => `B${block.index}.${index + 1} ${row.join(' | ')}`);
    return block.columns ? [`Columns: ${block.columns.join(' | ')}`, ...rows] : rows;
  }

  const text = marked(block.text, block) + hiddenLinks(block.text, block.links);
  return [block.heading ? `## B${block.index} ${text}` : `B${block.index} ${text}`];
}

// Builds the compact text sent to AI. Each line starts with a reference to the
// stored line (`L5`, PDF) or block (`B3`, DOCX), so extracted values can be
// traced back to the stored result without sending coordinates.
export function buildAiInput(content: Pick<ExtractionResult, 'pages' | 'blocks'>): string {
  const regions = content.pages.flatMap((page) => page.regions);
  const gap = usualGap(regions);
  const pageLines = content.pages.flatMap((page) =>
    page.regions.flatMap((region) => [
      `[P${page.pageNumber} R${region.index}${region.role ? ` ${region.role}` : ''}${region.parentIndex == null ? '' : ` parent R${region.parentIndex}`}]`,
      ...regionLines(region, gap)
    ])
  );

  return [...pageLines, ...content.blocks.flatMap(blockLines)].join('\n');
}
