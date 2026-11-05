import { buildAiInput } from './ai-input.js';
import { DocumentBlock, ExtractionResult, ParsedPage, Region, TextLine } from './parsing.types.js';

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

export function buildParsingInspectionReport(result: ExtractionResult, sourceName: string): string {
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
<section><h2>AI input</h2><pre>${escapeHtml(buildAiInput(result))}</pre></section>
<details><summary>Raw extraction JSON</summary><pre>${escapeHtml(
    JSON.stringify(result, null, 2)
  )}</pre></details></body></html>`;
}
