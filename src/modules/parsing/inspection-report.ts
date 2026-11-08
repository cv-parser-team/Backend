import { buildAiInput } from './ai-input.js';
import type {
  LayoutLine,
  LayoutTrace,
  LayoutTracePage,
  MetricCluster,
  PageMetrics
} from './layout.js';
import type {
  BoundaryCandidate,
  NonTextBoundaryCandidate,
  ScoredEvidence
} from './boundary-candidates.js';
import type { LayoutZoneCandidate } from './macro-layout.js';
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
  item: TextPiece | LayoutLine,
  page: LayoutTracePage,
  kind: 'piece' | 'line'
): string {
  return `<span class="trace-item ${kind}" style="left:${percentage(
    item.box.x,
    page.width
  )};top:${percentage(item.box.y, page.height)};width:${percentage(
    item.box.width,
    page.width
  )};height:${percentage(item.box.height, page.height)}" title="${escapeHtml(
    item.text
  )}">${escapeHtml(item.text)}</span>`;
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
  items: (TextPiece | LayoutLine)[],
  label: string
): string {
  const rows = items
    .map((item, index) => {
      const style = [item.bold ? 'bold' : null, item.italic ? 'italic' : null]
        .filter((value): value is string => value !== null)
        .join(', ');
      return `<li><code>${index + 1}</code><span>${escapeHtml(item.text)}</span><small>${escapeHtml(
        `${style || 'regular'} · x ${item.box.x}, y ${item.box.y}, w ${item.box.width}, h ${item.box.height}`
      )}</small></li>`;
    })
    .join('');
  return `<details><summary>${escapeHtml(label)} (${items.length})</summary><ol>${rows}</ol></details>`;
}

function traceStage(
  title: string,
  description: string,
  page: LayoutTracePage,
  items: (TextPiece | LayoutLine)[]
): string {
  const kind = title === '1. Extracted pieces' ? 'piece' : 'line';
  const primitives = kind === 'piece'
    ? `${page.marks.map((mark) => tracePositionedMark(mark, page)).join('')}${page.separators
        .map((separator) => tracePositionedSeparator(separator, page))
        .join('')}`
    : '';
  return `<details class="trace-stage"><summary><strong>${escapeHtml(title)}</strong> — ${escapeHtml(
    description
  )}</summary><div class="trace-page" style="aspect-ratio:${page.width}/${page.height}">${primitives}${items.map((item) => tracePositionedItem(item, page, kind)).join('')}</div>${traceItems(
    items,
    kind === 'piece' ? 'Pieces' : 'Lines'
  )}${kind === 'piece' ? traceDrawnPrimitives(page) : ''}</details>`;
}

function metricClusters(label: string, clusters: MetricCluster[]): string {
  const rows = clusters
    .map(
      (cluster) => `<li><code>${cluster.value}</code><span>${cluster.count} lines</span><small>${cluster.share} share</small></li>`
    )
    .join('');
  return `<details><summary>${escapeHtml(label)} (${clusters.length})</summary><ol>${rows}</ol></details>`;
}

function metricsStage(page: LayoutTracePage, metrics: PageMetrics): string {
  const active = metrics.activeContentBox
    ? `<div class="trace-active-box" style="left:${percentage(
        metrics.activeContentBox.x,
        page.width
      )};top:${percentage(metrics.activeContentBox.y, page.height)};width:${percentage(
        metrics.activeContentBox.width,
        page.width
      )};height:${percentage(metrics.activeContentBox.height, page.height)}"></div>`
    : '';
  const gutters = metrics.verticalGutters
    .map(
      (candidate) => `<div class="trace-metric-gutter" style="left:${percentage(
        candidate.box.x,
        page.width
      )};top:${percentage(candidate.box.y, page.height)};width:${percentage(
        candidate.box.width,
        page.width
      )};height:${percentage(candidate.box.height, page.height)}" title="vertical gutter · width ${candidate.size} · coverage ${candidate.coverage}"></div>`
    )
    .join('');
  const bands = metrics.horizontalBands
    .map(
      (candidate) => `<div class="trace-metric-band" style="left:${percentage(
        candidate.box.x,
        page.width
      )};top:${percentage(candidate.box.y, page.height)};width:${percentage(
        candidate.box.width,
        page.width
      )};height:${percentage(candidate.box.height, page.height)}" title="horizontal whitespace band · height ${candidate.size}"></div>`
    )
    .join('');
  const styleRows = metrics.styleClusters
    .map(
      (cluster) => `<li><code>${cluster.height}</code><span>${cluster.bold ? 'bold' : 'regular'}${
        cluster.italic ? ', italic' : ''
      }</span><small>${cluster.count} lines · ${cluster.share} share</small></li>`
    )
    .join('');
  const separatorRows = metrics.separatorCoverage
    .map(
      (item) => `<li><code>${item.separatorIndex + 1}</code><span>separator</span><small>${item.coverage} active-content coverage</small></li>`
    )
    .join('');

  return `<details class="trace-stage"><summary><strong>3. Page metrics</strong> — page-local measurements and non-destructive whitespace candidates</summary><div class="trace-page" style="aspect-ratio:${page.width}/${page.height}">${active}${gutters}${bands}${page.reconstructedLines
    .map((line) => tracePositionedItem(line, page, 'line'))
    .join('')}</div><p>Usual body height: <code>${metrics.usualBodyHeight}</code> · usual vertical gap: <code>${metrics.usualVerticalGap}</code> · vertical gutters: <code>${metrics.verticalGutters.length}</code> · horizontal bands: <code>${metrics.horizontalBands.length}</code></p>${metricClusters(
    'Left edges',
    metrics.leftEdges
  )}${metricClusters('Right edges', metrics.rightEdges)}${metricClusters(
    'Row baselines',
    metrics.rowBaselines
  )}${metricClusters('Height clusters', metrics.heightClusters)}<details><summary>Style clusters (${metrics.styleClusters.length})</summary><ol>${styleRows}</ol></details><details><summary>Separator coverage (${metrics.separatorCoverage.length})</summary><ol>${separatorRows}</ol></details></details>`;
}

function evidenceText(label: string, item: ScoredEvidence): string {
  const reasons = item.reasons.length > 0 ? ` — ${item.reasons.join('; ')}` : '';
  return `${label} ${item.score}${reasons}`;
}

type BoundaryRole = 'header' | 'section' | 'entry' | 'content';

function strongestCandidate(candidate: BoundaryCandidate): BoundaryRole {
  const roles: BoundaryRole[] = [
    'header',
    'section',
    'entry',
    'content'
  ];
  return roles.reduce((strongest, role) =>
    candidate[role].score > candidate[strongest].score ? role : strongest
  );
}

function positionedBoundaryCandidate(
  line: LayoutTracePage['reconstructedLines'][number],
  candidate: BoundaryCandidate,
  page: LayoutTracePage
): string {
  const strongest = strongestCandidate(candidate);
  const title = [
    evidenceText('header', candidate.header),
    evidenceText('section', candidate.section),
    evidenceText('entry', candidate.entry),
    evidenceText('content', candidate.content)
  ].join(' | ');
  return `<span class="trace-item candidate-${strongest}" style="left:${percentage(
    line.box.x,
    page.width
  )};top:${percentage(line.box.y, page.height)};width:${percentage(
    line.box.width,
    page.width
  )};height:${percentage(line.box.height, page.height)}" title="${escapeHtml(title)}">${escapeHtml(
    line.text
  )}</span>`;
}

function positionedNonTextCandidate(
  candidate: NonTextBoundaryCandidate,
  page: LayoutTracePage
): string {
  return `<div class="trace-boundary-evidence ${candidate.kind}" style="left:${percentage(
    candidate.box.x,
    page.width
  )};top:${percentage(candidate.box.y, page.height)};width:${percentage(
    candidate.box.width,
    page.width
  )};height:${percentage(candidate.box.height, page.height)}" title="${escapeHtml(
    evidenceText(candidate.kind, candidate.evidence)
  )}"></div>`;
}

function boundaryCandidateStage(page: LayoutTracePage): string {
  const rows = page.boundaryCandidates
    .map((candidate) => {
      const line = page.reconstructedLines[candidate.lineIndex]!;
      const scores = [
        evidenceText('header', candidate.header),
        evidenceText('section', candidate.section),
        evidenceText('entry', candidate.entry),
        evidenceText('content', candidate.content)
      ].join(' | ');
      return `<li><code>${candidate.lineIndex + 1}</code><span>${escapeHtml(
        line.text
      )}</span><small>${escapeHtml(scores)}</small></li>`;
    })
    .join('');
  const nonTextRows = page.nonTextBoundaryCandidates
    .map(
      (candidate, index) => `<li><code>${index + 1}</code><span>${candidate.kind}</span><small>${escapeHtml(
        evidenceText('score', candidate.evidence)
      )} · x ${candidate.box.x}, y ${candidate.box.y}, w ${candidate.box.width}, h ${candidate.box.height}</small></li>`
    )
    .join('');
  return `<details class="trace-stage"><summary><strong>4. Scored boundary candidates</strong> — competing line roles and non-text boundary evidence before layout actions</summary><div class="trace-page" style="aspect-ratio:${page.width}/${page.height}">${page.nonTextBoundaryCandidates
    .map((candidate) => positionedNonTextCandidate(candidate, page))
    .join('')}${page.boundaryCandidates
    .map((candidate) =>
      positionedBoundaryCandidate(
        page.reconstructedLines[candidate.lineIndex]!,
        candidate,
        page
      )
    )
    .join('')}</div><details><summary>Line candidates (${page.boundaryCandidates.length})</summary><ol>${rows}</ol></details><details><summary>Non-text candidates (${page.nonTextBoundaryCandidates.length})</summary><ol>${nonTextRows}</ol></details></details>`;
}

function positionedZoneCandidate(
  candidate: LayoutZoneCandidate,
  candidateIndex: number,
  page: LayoutTracePage
): string {
  const parts = candidate.parts
    .map(
      (part) => `<div class="trace-zone-part ${part.label}" style="left:${percentage(
        part.box.x,
        page.width
      )};top:${percentage(part.box.y, page.height)};width:${percentage(
        part.box.width,
        page.width
      )};height:${percentage(part.box.height, page.height)}" title="H${candidateIndex + 1} ${part.label} · lines ${part.lineIndexes
        .map((index) => index + 1)
        .join(', ')}"></div>`
    )
    .join('');
  const boundary = candidate.boundaryBox
    ? `<div class="trace-zone-boundary" style="left:${percentage(
        candidate.boundaryBox.x,
        page.width
      )};top:${percentage(candidate.boundaryBox.y, page.height)};width:${percentage(
        candidate.boundaryBox.width,
        page.width
      )};height:${percentage(candidate.boundaryBox.height, page.height)}"></div>`
    : '';
  return `${parts}${boundary}`;
}

function layoutZoneCandidateStage(page: LayoutTracePage): string {
  const rows = page.layoutZoneCandidates
    .map(
      (candidate, index) => `<li><code>H${index + 1}</code><span>${candidate.kind}</span><small>confidence ${candidate.confidence} · lines ${candidate.participatingLineIndexes
        .map((lineIndex) => lineIndex + 1)
        .join(', ')} · ${escapeHtml(candidate.reasons.join('; '))}</small></li>`
    )
    .join('');
  return `<details class="trace-stage"><summary><strong>5. Provisional macro layout hypotheses</strong> — overlapping page-level zones without ownership or exclusion</summary><div class="trace-page" style="aspect-ratio:${page.width}/${page.height}">${page.layoutZoneCandidates
    .map((candidate, index) => positionedZoneCandidate(candidate, index, page))
    .join('')}${page.reconstructedLines
    .map((line) => tracePositionedItem(line, page, 'line'))
    .join('')}</div><details><summary>Layout zone candidates (${page.layoutZoneCandidates.length})</summary><ol>${rows}</ol></details></details>`;
}

function sectionScopeStage(page: LayoutTracePage): string {
  const boxes = page.sectionScopes
    .map(
      (scope, index) => `<div class="trace-section-scope ${scope.status}" style="left:${percentage(
        scope.box.x,
        page.width
      )};top:${percentage(scope.box.y, page.height)};width:${percentage(
        scope.box.width,
        page.width
      )};height:${percentage(scope.box.height, page.height)}" title="S${index + 1} ${scope.kind} ${scope.status} ${scope.mode}"></div>`
    )
    .join('');
  const rows = page.sectionScopes
    .map((scope, index) => {
      const heading = page.reconstructedLines[scope.headingLineIndex]!;
      const hypotheses = scope.governingZoneCandidateIndexes.length > 0
        ? ` · hypotheses ${scope.governingZoneCandidateIndexes.map((zoneIndex) => `H${zoneIndex + 1}`).join(', ')}`
        : '';
      return `<li><code>S${index + 1}</code><span>${escapeHtml(heading.text)}</span><small>${scope.kind} · ${scope.status} · ${scope.mode} · confidence ${scope.confidence} · heading line ${scope.headingLineIndex + 1} · governed lines ${scope.lineIndexes
        .map((lineIndex) => lineIndex + 1)
        .join(', ')}${hypotheses} · ${escapeHtml(scope.reasons.join('; '))}</small></li>`;
    })
    .join('');
  return `<details class="trace-stage"><summary><strong>6. Section scopes</strong> — contextual section authority that may cross provisional gutters</summary><div class="trace-page" style="aspect-ratio:${page.width}/${page.height}">${boxes}${page.reconstructedLines
    .map((line) => tracePositionedItem(line, page, 'line'))
    .join('')}</div><details><summary>Section scopes (${page.sectionScopes.length})</summary><ol>${rows}</ol></details></details>`;
}

function entryGroupStage(page: LayoutTracePage): string {
  const groupBoxes = page.entryGroups.map((group, index) =>
    `<div class="trace-entry-group" style="left:${percentage(group.box.x, page.width)};top:${percentage(group.box.y, page.height)};width:${percentage(group.box.width, page.width)};height:${percentage(group.box.height, page.height)}" title="G${index + 1} anchor L${group.anchorLineIndex + 1}"></div>`
  ).join('');
  const anchors = page.entryAnchors.map((anchor, index) =>
    `<li><code>E${index + 1}</code><span>${escapeHtml(page.reconstructedLines[anchor.lineIndex]!.text)}</span><small>line ${anchor.lineIndex + 1} · section heading ${anchor.sectionHeadingLineIndex + 1} · confidence ${anchor.confidence} · ${escapeHtml(anchor.reasons.join('; '))}</small></li>`
  ).join('');
  const groups = page.entryGroups.map((group, index) =>
    `<li><code>G${index + 1}</code><span>anchor L${group.anchorLineIndex + 1}</span><small>section heading L${group.sectionHeadingLineIndex + 1} · confidence ${group.confidence} · lines ${group.lineIndexes.map((lineIndex) => lineIndex + 1).join(', ')}</small></li>`
  ).join('');
  return `<details class="trace-stage"><summary><strong>7. Entry groups</strong> — contextual anchors and the lines they own inside confirmed sections</summary><div class="trace-page" style="aspect-ratio:${page.width}/${page.height}">${groupBoxes}${page.reconstructedLines.map((line) => tracePositionedItem(line, page, 'line')).join('')}</div><details><summary>Entry anchors (${page.entryAnchors.length})</summary><ol>${anchors}</ol></details><details><summary>Entry groups (${page.entryGroups.length})</summary><ol>${groups}</ol></details></details>`;
}

function validatedLayoutStage(page: LayoutTracePage): string {
  const rows = page.validatedZones.map((zone) => {
    const candidate = page.layoutZoneCandidates[zone.candidateIndex]!;
    return `<li><code>H${zone.candidateIndex + 1}</code><span>${zone.accepted ? 'accepted' : 'rejected'} ${candidate.kind}</span><small>confidence ${zone.confidence} · ${escapeHtml(zone.reasons.join('; '))}</small></li>`;
  }).join('');
  const columns = page.sectionColumns.map((column, index) =>
    `<li><code>C${index + 1}</code><span>section column</span><small>${column.source} · section heading L${column.sectionHeadingLineIndex + 1} · confidence ${column.confidence} · lines ${column.lineIndexes.map((lineIndex) => lineIndex + 1).join(', ')}</small></li>`
  ).join('');
  return `<details class="trace-stage"><summary><strong>8. Validated section columns</strong> — clean local gaps or validated layout zones create lanes only inside a confirmed section and outside entry groups</summary><details><summary>Zone decisions (${page.validatedZones.length})</summary><ol>${rows}</ol></details><details><summary>Section columns (${page.sectionColumns.length})</summary><ol>${columns}</ol></details></details>`;
}

function finalOwnershipStage(page: LayoutTracePage): string {
  const boxes = page.finalRegions.map((region) =>
    `<div class="trace-final-region ${region.role}" style="left:${percentage(region.box.x, page.width)};top:${percentage(region.box.y, page.height)};width:${percentage(region.box.width, page.width)};height:${percentage(region.box.height, page.height)}" title="R${region.index} ${region.role}${region.parentIndex === null ? '' : ` parent R${region.parentIndex}`}"></div>`
  ).join('');
  const rows = page.finalRegions.map((region) =>
    `<li><code>R${region.index}</code><span>${region.role}</span><small>${region.parentIndex === null ? 'no parent' : `parent R${region.parentIndex}`} · confidence ${region.confidence} · stored lines ${region.lineIndexes.map((lineIndex) => lineIndex + 1).join(', ')} · reading order ${region.readingOrderLineIndexes.map((lineIndex) => lineIndex + 1).join(', ')}</small></li>`
  ).join('');
  return `<details class="trace-stage"><summary><strong>9. Final ownership and reading order</strong> — disjoint line ownership after constrained splitting</summary><div class="trace-page" style="aspect-ratio:${page.width}/${page.height}">${boxes}${page.reconstructedLines.map((line) => tracePositionedItem(line, page, 'line')).join('')}</div><ol>${rows}</ol></details>`;
}

function revisedAiInputStage(page: LayoutTracePage): string {
  return `<details class="trace-stage"><summary><strong>10. Revised compact AI input</strong> — finalized roles, parents, and line references</summary><pre>${escapeHtml(page.revisedAiInputLines.join('\n'))}</pre></details>`;
}

function layoutTraceReport(trace: LayoutTrace): string {
  const pages = trace.pages
    .map(
      (page) => `<article><h3>Page ${page.pageNumber}</h3>
${traceStage('1. Extracted pieces', 'PDF text items, drawn marks, and separators before line reconstruction', page, page.pieces)}
${traceStage('2. Reconstructed lines', 'pieces grouped into visual rows', page, page.reconstructedLines)}
${metricsStage(page, page.metrics)}
${boundaryCandidateStage(page)}
${layoutZoneCandidateStage(page)}
${sectionScopeStage(page)}
${entryGroupStage(page)}
${validatedLayoutStage(page)}
${finalOwnershipStage(page)}
${revisedAiInputStage(page)}
</article>`
    )
    .join('');
  return `<section><h2>Parsing levels</h2><p>Usual line height: <code>${trace.usualHeight}</code> · usual vertical gap: <code>${trace.usualGap}</code></p><div class="legend"><span class="piece-key">piece</span><span class="mark-key">drawn mark</span><span class="separator-key">separator</span><span class="gutter-key">gutter candidate</span><span class="band-key">whitespace band</span><span class="header-candidate-key">header candidate</span><span class="section-key">section candidate</span><span class="entry-key">entry candidate</span><span class="content-candidate-key">content candidate</span><span class="zone-key">provisional zone</span><span class="confirmed-scope-key">confirmed scope</span><span class="provisional-scope-key">provisional scope</span><span class="region-key">region</span></div>${pages}</section>`;
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
.trace-stage>summary{cursor:pointer;padding:8px 0}.trace-page{position:relative;width:min(100%,850px);background:#fff;color:#111;border:1px solid #777;overflow:hidden;margin:12px 0}.trace-item{position:absolute;overflow:hidden;white-space:nowrap;font-size:clamp(4px,1.1vw,12px);line-height:1;background:#457b9d18;border-bottom:1px solid #457b9d55}.trace-item.piece{background:#8338ec24;border-color:#8338ec88}.trace-item.section-boundary,.trace-item.candidate-section{background:#f4a26188;border-color:#e76f51}.trace-item.entry-boundary,.trace-item.candidate-entry{background:#2a9d8f66;border-color:#198754}.trace-item.header-boundary,.trace-item.candidate-header{background:#e9c46a88;border-color:#b08900}.trace-item.candidate-content{background:#457b9d18;border-color:#457b9d55}.trace-region{position:absolute;box-sizing:border-box;border:2px dashed #e63946;background:#e6394608;pointer-events:none}.trace-mark{position:absolute;box-sizing:border-box;background:#d00000;border:1px solid #7f0000;min-width:2px;min-height:2px}.trace-separator{position:absolute;box-sizing:border-box;background:#00b4d8;min-width:2px;min-height:2px}.trace-separator.vertical{background:#0096c7}.trace-active-box{position:absolute;box-sizing:border-box;border:1px dotted #6c757d;pointer-events:none}.trace-metric-gutter{position:absolute;box-sizing:border-box;background:#ff006e20;border-left:1px solid #ff006e88;border-right:1px solid #ff006e88;pointer-events:none}.trace-metric-band{position:absolute;box-sizing:border-box;background:#3a86ff20;border-top:1px solid #3a86ff88;border-bottom:1px solid #3a86ff88;pointer-events:none}.trace-boundary-evidence{position:absolute;box-sizing:border-box;pointer-events:none}.trace-boundary-evidence.vertical-gutter{background:#ff006e16;border-left:1px solid #ff006e66;border-right:1px solid #ff006e66}.trace-boundary-evidence.horizontal-band,.trace-boundary-evidence.alignment-change{background:#3a86ff16;border-top:1px solid #3a86ff66;border-bottom:1px solid #3a86ff66}.trace-boundary-evidence.separator{background:#00b4d855;min-height:2px}.trace-zone-part{position:absolute;box-sizing:border-box;border:2px solid #7209b755;background:#7209b710;pointer-events:none}.trace-zone-part.header,.trace-zone-part.full-width-section{border-color:#f7258588;background:#f7258512}.trace-zone-part.left-lane{border-color:#7209b788}.trace-zone-part.right-lane,.trace-zone-part.body{border-color:#4361ee88;background:#4361ee10}.trace-zone-boundary{position:absolute;box-sizing:border-box;background:#4cc9f055;border:1px dashed #0077b6;min-width:2px;min-height:2px;pointer-events:none}.trace-section-scope{position:absolute;box-sizing:border-box;pointer-events:none}.trace-section-scope.confirmed{border:3px solid #2d6a4f;background:#2d6a4f0d}.trace-section-scope.provisional{border:2px dashed #f77f00;background:#f77f000d}.legend{display:flex;flex-wrap:wrap;gap:8px}.legend span{border:1px solid #8885;border-radius:6px;padding:4px 8px}.piece-key{background:#8338ec24}.mark-key{background:#d00000}.separator-key{background:#00b4d8}.gutter-key{background:#ff006e20}.band-key{background:#3a86ff20}.header-candidate-key{background:#e9c46a88}.section-key{background:#f4a26188}.entry-key{background:#2a9d8f66}.content-candidate-key{background:#457b9d18}.zone-key{border:2px solid #7209b788!important;background:#7209b710}.confirmed-scope-key{border:3px solid #2d6a4f!important;background:#2d6a4f0d}.provisional-scope-key{border:2px dashed #f77f00!important;background:#f77f000d}.region-key{border:2px dashed #e63946!important}
ol{padding:0;list-style:none}li{display:grid;grid-template-columns:65px 1fr;gap:4px 10px;padding:7px 0;border-bottom:1px solid #8883}li small{grid-column:2}table{border-collapse:collapse;width:100%}th,td{border:1px solid #8885;padding:8px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#7772;border-radius:8px;padding:14px}code{font-family:ui-monospace,monospace}
.trace-entry-group{position:absolute;box-sizing:border-box;border:2px solid #8338ec;background:#8338ec12;pointer-events:none}.trace-final-region{position:absolute;box-sizing:border-box;border:2px solid #264653;background:#2646530d;pointer-events:none}.trace-final-region.entry{border-color:#2a9d8f}.trace-final-region.section{border-color:#e76f51}
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
