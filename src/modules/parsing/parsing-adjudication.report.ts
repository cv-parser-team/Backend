import type { LayoutTrace } from './layout.js';
import type { AdjudicationCase } from './parsing-adjudication.js';
import type { AdjudicationResult } from './parsing-adjudication.ai.js';

export const ADJUDICATION_REPORT_STYLES =
  '.adjudication td{vertical-align:top}.adjudication .applied{color:#198754;font-weight:600}.adjudication .kept{opacity:.75}';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function targetText(trace: LayoutTrace, item: AdjudicationCase): string {
  const page = trace.pages.find((candidate) => candidate.pageNumber === item.pageNumber);
  return item.lineIndexes
    .map((lineIndex, index) => `${item.lineRefs[index]}: ${page?.reconstructedLines[lineIndex]?.text ?? ''}`)
    .join('\n');
}

// Lists every uncertain decision with the parser's choice, the AI's answer,
// and what was applied. The layout shown elsewhere in the report is the one
// rebuilt with the applied decisions.
export function buildAdjudicationReport(
  trace: LayoutTrace,
  cases: AdjudicationCase[],
  result: AdjudicationResult
): string {
  const applied = result.decisions.filter((decision) => decision.source === 'ai').length;
  const summary = cases.length === 0
    ? 'No uncertain decisions; the AI was not asked.'
    : `${cases.length} uncertain decisions, ${applied} AI choices applied${
        result.failure ? `; the request failed (${escapeHtml(result.failure)}), so every parser decision was kept` : ''
      }. Invocation: ${escapeHtml(result.invocationId ?? 'none')}.`;

  const rows = cases.map((item) => {
    const decision = result.decisions.find((candidate) => candidate.caseId === item.caseId);
    const aiApplied = decision?.source === 'ai';
    const answer = decision
      ? `${escapeHtml(decision.choice)}${decision.confidence === null ? '' : ` (${decision.confidence})`}<br><small>${escapeHtml(decision.reason)}</small>`
      : '—';
    return `<tr><td><code>${escapeHtml(item.kind)}</code></td><td><pre>${escapeHtml(
      targetText(trace, item)
    )}</pre></td><td>${item.options.map((option) => `<code>${escapeHtml(option)}</code>`).join(' ')}</td><td><code>${escapeHtml(
      item.deterministic
    )}</code></td><td>${answer}</td><td class="${aiApplied ? 'applied' : 'kept'}">${
      aiApplied
        ? `AI: ${escapeHtml(decision.choice)}`
        : `Parser: ${escapeHtml(item.deterministic)}${decision?.fallback ? ` <small>(${escapeHtml(decision.fallback)})</small>` : ''}`
    }</td></tr>`;
  });

  const table = rows.length === 0
    ? ''
    : `<table><thead><tr><th>Kind</th><th>Lines</th><th>Options</th><th>Parser</th><th>AI answer</th><th>Applied</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;

  return `<section class="adjudication"><h2>AI adjudication</h2><p>${summary}</p>${table}</section>`;
}
