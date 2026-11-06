import { buildAiInput } from './ai-input.js';
import type {
  LayoutTrace,
  LayoutTraceLine,
  LayoutTracePage,
  LayoutTraceRegion
} from './layout.js';
import {
  BoundingBox,
  DocumentBlock,
  DrawnSeparator,
  ExtractionResult,
  ParsedPage,
  Region,
  TextLine,
  TextPiece
} from './parsing.types.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function percentage(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(3)}%`;
}

function flags(line: TextLine): string {
  return [
    line.heading ? 'heading' : null,
    line.bold ? 'bold' : null,
    line.italic ? 'italic' : null,
    line.bullet ? 'bullet' : null
  ]
    .filter((flag): flag is string => flag !== null)
    .join(', ');
}

function positionedLine(line: TextLine, page: ParsedPage): string {
  return `<span class="line${line.heading ? ' heading' : ''}" style="left:${percentage(
    line.box.x,
    page.width
  )};top:${percentage(line.box.y, page.height)};width:${percentage(
    line.box.width,
    page.width
  )};height:${percentage(line.box.height, page.height)}" title="${escapeHtml(
    `L${line.order}: ${line.text}`
  )}">${escapeHtml(line.text)}</span>`;
}

function positionedRegion(region: Region, page: ParsedPage): string {
  return `<div class="region" style="left:${percentage(
    region.box.x,
    page.width
  )};top:${percentage(region.box.y, page.height)};width:${percentage(
    region.box.width,
    page.width
  )};height:${percentage(region.box.height, page.height)}"></div>`;
}

function regionDetails(region: Region): string {
  const lines = region.lines
    .map(
      (line) => `<li><code>L${line.order}</code><span>${escapeHtml(line.text)}</span><small>${escapeHtml(
        flags(line) || 'regular'
      )} · x ${line.box.x}, y ${line.box.y}, w ${line.box.width}, h ${line.box.height}</small></li>`
    )
    .join('');
  return `<section><h4>Region ${region.index} <small>confidence: ${
    region.confidence ?? 'none'
  }</small></h4><ol>${lines}</ol></section>`;
}

function tracePositionedItem(
  item: TextPiece | LayoutTraceLine,
  page: LayoutTracePage,
  kind: 'piece' | 'line'
): string {
  const action = 'layoutAction' in item ? item.layoutAction : 'none';
  const classes = ['trace-item', kind, action !== 'none' ? action : null]
    .filter((value): value is string => value !== null)
    .join(' ');
  return `<span class="${classes}" style="left:${percentage(
    item.box.x,
    page.width
  )};top:${percentage(item.box.y, page.height)};width:${percentage(
    item.box.width,
    page.width
  )};height:${percentage(item.box.height, page.height)}" title="${escapeHtml(
    `${action}: ${item.text}`
  )}">${escapeHtml(item.text)}</span>`;
}

function tracePositionedRegion(region: LayoutTraceRegion, page: LayoutTracePage): string {
  return `<div class="trace-region" style="left:${percentage(
    region.box.x,
    page.width
  )};top:${percentage(region.box.y, page.height)};width:${percentage(
    region.box.width,
    page.width
  )};height:${percentage(region.box.height, page.height)}"></div>`;
}

function tracePositionedMark(mark: BoundingBox, page: LayoutTracePage): string {
  return `<div class="trace-mark" style="left:${percentage(
    mark.x,
    page.width
  )};top:${percentage(mark.y, page.height)};width:${percentage(
    mark.width,
    page.width
  )};height:${percentage(mark.height, page.height)}" title="drawn mark"></div>`;
}

function tracePositionedSeparator(
  separator: DrawnSeparator,
  page: LayoutTracePage
): string {
  return `<div class="trace-separator ${separator.orientation}" style="left:${percentage(
    separator.box.x,
    page.width
  )};top:${percentage(separator.box.y, page.height)};width:${percentage(
    separator.box.width,
    page.width
  )};height:${percentage(separator.box.height, page.height)}" title="${separator.orientation} separator · thickness ${separator.thickness}"></div>`;
}

function traceDrawnPrimitives(page: LayoutTracePage): string {
  const marks = page.marks
    .map(
      (mark, index) => `<li><code>${index + 1}</code><span>drawn mark</span><small>x ${mark.x}, y ${mark.y}, w ${mark.width}, h ${mark.height}</small></li>`
    )
    .join('');
  const separators = page.separators
    .map(
      (separator, index) => `<li><code>${index + 1}</code><span>${separator.orientation} separator</span><small>thickness ${separator.thickness} · x ${separator.box.x}, y ${separator.box.y}, w ${separator.box.width}, h ${separator.box.height}</small></li>`
    )
    .join('');
  return `<details><summary>Marks (${page.marks.length})</summary><ol>${marks}</ol></details><details><summary>Separators (${page.separators.length})</summary><ol>${separators}</ol></details>`;
}

function traceItems(
  items: (TextPiece | LayoutTraceLine)[],
  label: string
): string {
  const rows = items
    .map((item, index) => {
      const action = 'layoutAction' in item && item.layoutAction !== 'none'
        ? ` · ${item.layoutAction}`
        : '';
      const style = [item.bold ? 'bold' : null, item.italic ? 'italic' : null]
        .filter((value): value is string => value !== null)
        .join(', ');
      return `<li><code>${index + 1}</code><span>${escapeHtml(item.text)}</span><small>${escapeHtml(
        `${style || 'regular'}${action} · x ${item.box.x}, y ${item.box.y}, w ${item.box.width}, h ${item.box.height}`
      )}</small></li>`;
    })
    .join('');
  return `<details><summary>${escapeHtml(label)} (${items.length})</summary><ol>${rows}</ol></details>`;
}

function traceStage(
  title: string,
  description: string,
  page: LayoutTracePage,
  items: (TextPiece | LayoutTraceLine)[],
  regions: LayoutTraceRegion[] = []
): string {
  const kind = title === '1. Extracted pieces' ? 'piece' : 'line';
  const primitives = kind === 'piece'
    ? `${page.marks.map((mark) => tracePositionedMark(mark, page)).join('')}${page.separators
        .map((separator) => tracePositionedSeparator(separator, page))
        .join('')}`
    : '';
  return `<details class="trace-stage"><summary><strong>${escapeHtml(title)}</strong> — ${escapeHtml(
    description
  )}</summary><div class="trace-page" style="aspect-ratio:${page.width}/${page.height}">${regions
    .map((region) => tracePositionedRegion(region, page))
    .join('')}${primitives}${items.map((item) => tracePositionedItem(item, page, kind)).join('')}</div>${traceItems(
    items,
    kind === 'piece' ? 'Pieces' : 'Lines'
  )}${kind === 'piece' ? traceDrawnPrimitives(page) : ''}</details>`;
}

function layoutTraceReport(trace: LayoutTrace): string {
  const pages = trace.pages
    .map(
      (page) => `<article><h3>Page ${page.pageNumber}</h3>
${traceStage('1. Extracted pieces', 'PDF text items, drawn marks, and separators before line reconstruction', page, page.pieces)}
${traceStage('2. Reconstructed lines', 'pieces grouped into visual rows', page, page.reconstructedLines)}
${traceStage('3. Classified boundaries', 'document, section, and entry authority', page, page.classifiedLines)}
${traceStage('4. Recursive splits', 'regions before ownership repair', page, page.classifiedLines, page.splitRegions)}
${traceStage('5. Section ownership', 'regions after headings reclaim their content', page, page.classifiedLines, page.ownedRegions)}
</article>`
    )
    .join('');
  return `<section><h2>Parsing levels</h2><p>Usual line height: <code>${trace.usualHeight}</code> · usual vertical gap: <code>${trace.usualGap}</code></p><div class="legend"><span class="piece-key">piece</span><span class="mark-key">drawn mark</span><span class="separator-key">separator</span><span class="section-key">section boundary</span><span class="entry-key">entry boundary</span><span class="region-key">region</span></div>${pages}</section>`;
}

function pageReport(page: ParsedPage): string {
  const regions = page.regions.map((region) => positionedRegion(region, page)).join('');
  const lines = page.regions
    .flatMap((region) => region.lines.map((line) => positionedLine(line, page)))
    .join('');
  return `<article><h3>Page ${page.pageNumber} <small>${page.width} × ${
    page.height
  }</small></h3><div class="page" style="aspect-ratio:${page.width}/${
    page.height
  }">${regions}${lines}</div>${page.regions.map(regionDetails).join('')}</article>`;
}

function blockReport(block: DocumentBlock): string {
  if (block.type === 'paragraph') {
    return `<article><h3>B${block.index} Paragraph</h3><p>${escapeHtml(block.text)}</p></article>`;
  }
  const header = block.columns
    ? `<thead><tr>${block.columns.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
    : '';
  const rows = block.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<article><h3>B${block.index} Table</h3><table>${header}<tbody>${rows}</tbody></table></article>`;
}

export function buildParsingInspectionReport(
  result: ExtractionResult,
  sourceName: string,
  layoutTrace?: LayoutTrace
): string {
  const failures =
    result.failures.length === 0
      ? '<p class="success">No failures</p>'
      : `<ul>${result.failures
          .map(
            (failure) => `<li><code>${escapeHtml(failure.code)}</code> — ${
              failure.pageNumber === null ? 'whole document' : `page ${failure.pageNumber}`
            }</li>`
          )
          .join('')}</ul>`;
  const parsedContent =
    result.format === 'pdf'
      ? result.pages.map(pageReport).join('')
      : result.blocks.map(blockReport).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parsing inspection — ${escapeHtml(sourceName)}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:1200px;margin:auto;padding:24px;line-height:1.4}
header,article,section,details{border:1px solid #8885;border-radius:10px;padding:16px;margin:16px 0}h1,h2,h3,h4{margin-top:0}small{opacity:.7;font-weight:normal}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.summary div{border:1px solid #8885;border-radius:8px;padding:10px}.summary strong{display:block;font-size:1.1rem;overflow-wrap:anywhere}.success{color:#198754}
.page{position:relative;width:min(100%,850px);background:#fff;color:#111;border:1px solid #777;overflow:hidden}.region{position:absolute;box-sizing:border-box;border:2px dashed #e63946;background:#e6394608;pointer-events:none}.line{position:absolute;overflow:hidden;white-space:nowrap;font-size:clamp(4px,1.1vw,12px);line-height:1;background:#457b9d18;border-bottom:1px solid #457b9d55}.line.heading{background:#f4a26155;font-weight:700}
.trace-stage>summary{cursor:pointer;padding:8px 0}.trace-page{position:relative;width:min(100%,850px);background:#fff;color:#111;border:1px solid #777;overflow:hidden;margin:12px 0}.trace-item{position:absolute;overflow:hidden;white-space:nowrap;font-size:clamp(4px,1.1vw,12px);line-height:1;background:#457b9d18;border-bottom:1px solid #457b9d55}.trace-item.piece{background:#8338ec24;border-color:#8338ec88}.trace-item.section-boundary{background:#f4a26188;border-color:#e76f51}.trace-item.entry-boundary{background:#2a9d8f66;border-color:#198754}.trace-item.header-boundary{background:#e9c46a88;border-color:#b08900}.trace-region{position:absolute;box-sizing:border-box;border:2px dashed #e63946;background:#e6394608;pointer-events:none}.trace-mark{position:absolute;box-sizing:border-box;background:#d00000;border:1px solid #7f0000;min-width:2px;min-height:2px}.trace-separator{position:absolute;box-sizing:border-box;background:#00b4d8;min-width:2px;min-height:2px}.trace-separator.vertical{background:#0096c7}.legend{display:flex;flex-wrap:wrap;gap:8px}.legend span{border:1px solid #8885;border-radius:6px;padding:4px 8px}.piece-key{background:#8338ec24}.mark-key{background:#d00000}.separator-key{background:#00b4d8}.section-key{background:#f4a26188}.entry-key{background:#2a9d8f66}.region-key{border:2px dashed #e63946!important}
ol{padding:0;list-style:none}li{display:grid;grid-template-columns:65px 1fr;gap:4px 10px;padding:7px 0;border-bottom:1px solid #8883}li small{grid-column:2}table{border-collapse:collapse;width:100%}th,td{border:1px solid #8885;padding:8px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#7772;border-radius:8px;padding:14px}code{font-family:ui-monospace,monospace}
</style></head><body>
<header><h1>${escapeHtml(sourceName)}</h1><div class="summary"><div>Status<strong>${escapeHtml(
    result.status
  )}</strong></div><div>Format<strong>${escapeHtml(result.format)}</strong></div><div>Pages<strong>${
    result.pageCount ?? 'n/a'
  }</strong></div><div>Parser<strong>${escapeHtml(result.parserVersion)}</strong></div></div></header>
<section><h2>Failures</h2>${failures}</section><main><h2>Parsed content</h2>${
    parsedContent || '<p>No parsed content.</p>'
  }</main>
${layoutTrace ? layoutTraceReport(layoutTrace) : ''}
<section><h2>AI input</h2><pre>${escapeHtml(buildAiInput(result))}</pre></section>
<details><summary>Raw extraction JSON</summary><pre>${escapeHtml(
    JSON.stringify(result, null, 2)
  )}</pre></details></body></html>`;
}
