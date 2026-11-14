import type { CandidateExtractionResult } from './extraction.service.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function displayValue(value: string | string[] | undefined): string {
  if (value === undefined) {
    return '<span class="missing">Not provided</span>';
  }
  if (Array.isArray(value)) {
    return `<div class="tags">${value
      .map((item) => `<span>${escapeHtml(item)}</span>`)
      .join('')}</div>`;
  }
  return escapeHtml(value);
}

function reviewField(field: unknown): {
  value: string | string[] | undefined;
  raw: string | undefined;
  confidence: number | undefined;
  sources: string[];
} {
  if (typeof field !== 'object' || field === null || Array.isArray(field)) {
    return { value: undefined, raw: undefined, confidence: undefined, sources: [] };
  }
  const record = field as Record<string, unknown>;
  const value =
    typeof record.value === 'string' ||
    (Array.isArray(record.value) && record.value.every((item) => typeof item === 'string'))
      ? record.value as string | string[]
      : undefined;
  return {
    value,
    raw: typeof record.raw === 'string' ? record.raw : undefined,
    confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
    sources: Array.isArray(record.sources)
      ? record.sources.filter((source): source is string => typeof source === 'string')
      : []
  };
}

function sourceBadges(sources: string[] | undefined): string {
  if (!sources || sources.length === 0) {
    return '<span class="missing">No sources</span>';
  }
  return sources
    .map((source) => `<code class="source">${escapeHtml(source)}</code>`)
    .join('');
}

function confidenceBadge(confidence: number | undefined): string {
  if (confidence === undefined) {
    return '<span class="missing">No confidence</span>';
  }
  const percentage = Math.round(confidence * 100);
  const level = percentage >= 85 ? 'high' : percentage >= 65 ? 'medium' : 'low';
  return `<span class="confidence ${level}" title="Confidence ${confidence}"><span style="width:${percentage}%"></span><strong>${percentage}%</strong></span>`;
}

function profileValue(
  value: string | { label: string; url: string }[] | undefined
): string {
  if (value === undefined) {
    return '<span class="missing">Not provided</span>';
  }
  if (Array.isArray(value)) {
    return `<div class="links">${value
      .map(
        (link) => `<span><strong>${escapeHtml(link.label)}</strong><code>${escapeHtml(
          link.url
        )}</code></span>`
      )
      .join('')}</div>`;
  }
  return escapeHtml(value);
}

function profileSection(result: CandidateExtractionResult): string {
  const fields = Object.keys(result.profile.values);
  if (fields.length === 0) {
    return '<p class="empty">No structured profile fields were extracted.</p>';
  }

  return `<div class="profile-grid">${fields
    .map((field) => {
      const key = field as keyof typeof result.profile.values;
      const raw = result.profile.rawValues[key];
      return `<article class="field"><h3>${escapeHtml(field)}</h3><div class="value">${profileValue(
        result.profile.values[key]
      )}</div>${raw ? `<p class="raw">CV text: ${escapeHtml(raw)}</p>` : ''}<footer>${confidenceBadge(
        result.profile.confidence[key]
      )}<span class="sources">${sourceBadges(result.profile.sources[key])}</span></footer></article>`;
    })
    .join('')}</div>`;
}

function claimFields(
  claim: CandidateExtractionResult['claims'][number]
): string[] {
  return [
    ...new Set([
      ...Object.keys(claim.values),
      ...Object.keys(claim.rawValues),
      ...Object.keys(claim.fieldConfidence),
      ...Object.keys(claim.fieldSources)
    ])
  ];
}

function claimSection(result: CandidateExtractionResult): string {
  if (result.claims.length === 0) {
    return '<p class="empty">No valid structured claims were extracted.</p>';
  }

  return `<div class="claims">${result.claims
    .map(
      (claim, index) => `<article class="claim"><header><div><span class="claim-number">Claim ${
        index + 1
      }</span><h3>${escapeHtml(claim.type)}</h3></div>${confidenceBadge(
        claim.confidence
      )}</header><div class="claim-fields">${claimFields(claim)
        .map((field) => {
          const value = claim.values[field];
          const isCurrent = field === 'endDate' && claim.current && value === undefined;
          const raw = claim.rawValues[field];
          return `<div class="claim-field"><div><h4>${escapeHtml(
            field
          )}</h4><div class="value">${isCurrent ? '<span class="current">Current</span>' : displayValue(
            value
          )}</div>${raw ? `<p class="raw">CV text: ${escapeHtml(raw)}</p>` : ''}</div><div class="field-meta">${confidenceBadge(
            claim.fieldConfidence[field]
          )}<span class="sources">${sourceBadges(
            claim.fieldSources[field]
          )}</span></div></div>`;
        })
        .join('')}</div><footer><span>${escapeHtml(claim.origin)}</span><span>${escapeHtml(
        claim.status
      )}</span>${claim.current ? '<span>current role</span>' : ''}</footer></article>`
    )
    .join('')}</div>`;
}

function reviewSection(result: CandidateExtractionResult): string {
  if (result.reviewItems.length === 0) {
    return '<p class="empty">No claims require manual correction.</p>';
  }

  return `<div class="unmapped-list">${result.reviewItems
    .map(
      (item) => `<article><header><h3>${escapeHtml(
        item.claimType
      )}</h3><span>needs review</span></header><div class="claim-fields">${Object.entries(
        item.fields
      )
        .map(([fieldName, storedField]) => {
          const field = reviewField(storedField);
          return `<div class="claim-field"><div><h4>${escapeHtml(
            fieldName
          )}</h4><div class="value">${displayValue(field.value)}</div>${
            field.raw ? `<p class="raw">CV text: ${escapeHtml(field.raw)}</p>` : ''
          }</div><div class="field-meta">${confidenceBadge(
            field.confidence
          )}<span class="sources">${sourceBadges(field.sources)}</span></div></div>`
        })
        .join('')}</div><footer>${item.issues
        .map(
          (issue) => `<span class="review-issue">${escapeHtml(
            issue.field ?? 'claim'
          )}: ${escapeHtml(issue.code.replaceAll('_', ' '))}</span>`
        )
        .join('')}</footer></article>`
    )
    .join('')}</div>`;
}

function unmappedSection(result: CandidateExtractionResult): string {
  if (result.unmapped.length === 0) {
    return '<p class="empty">Nothing was left unmapped.</p>';
  }
  return `<div class="unmapped-list">${result.unmapped
    .map(
      (item) => `<article><header><h3>${escapeHtml(
        item.label
      )}</h3><span>${escapeHtml(item.reason.replaceAll('_', ' '))}</span></header><p>${escapeHtml(
        item.text
      )}</p><footer>${sourceBadges(item.sources)}</footer></article>`
    )
    .join('')}</div>`;
}

function inspectionSections(
  result: CandidateExtractionResult,
  input: string,
  includeEvidence = true
): string {
  return `<section class="panel"><h2>Candidate profile</h2>${profileSection(
    result
  )}</section><section class="panel"><h2>Structured claims</h2><p class="section-note">Confidence is shown for the whole claim and for each extracted field.</p>${claimSection(
    result
  )}</section><section class="panel"><h2>Claims needing review</h2><p class="section-note">Recognized claims retained with the fields and evidence needed for a user to correct them.</p>${reviewSection(
    result
  )}</section><section class="panel"><h2>Unmapped output</h2>${unmappedSection(
    result
  )}</section>${includeEvidence ? `<section class="panel"><h2>Evidence input</h2><p class="section-note">Source badges on fields refer to these compact input lines.</p><pre>${escapeHtml(
    input
  )}</pre><details><summary>Mapped extraction JSON</summary><pre>${escapeHtml(
    JSON.stringify(result, null, 2)
  )}</pre></details></section>` : ''}`;
}

function inspectionSummary(result: CandidateExtractionResult): string {
  return `<div class="summary"><div>Claims<strong>${
    result.claims.length
  }</strong></div><div>Needs review<strong>${result.reviewItems.length}</strong></div><div>Profile fields<strong>${Object.keys(result.profile.values).length}</strong></div><div>Unmapped<strong>${
    result.unmapped.length
  }</strong></div><div>Invocation<code>${escapeHtml(
    result.invocationId
  )}</code></div></div>`;
}

function providerOutputDetails(providerOutput: unknown): string {
  return `<details><summary>Provider structured output</summary><p class="section-note">Included only in this local inspection report; not stored in the application database or logs.</p><pre>${escapeHtml(
    JSON.stringify(providerOutput, null, 2)
  )}</pre></details>`;
}

export const EMBEDDED_LLM_INSPECTION_STYLES = `
.llm-output{border:2px solid #3157d577}.llm-output>.summary{margin-bottom:16px}.llm-output .section-note{opacity:.72;margin-top:-10px}.llm-output .profile-grid,.llm-output .claim-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.llm-output .field,.llm-output .claim,.llm-output .unmapped-list article{border:1px solid #8885;border-radius:9px;padding:14px}.llm-output .field h3,.llm-output .claim h3,.llm-output .unmapped-list h3{text-transform:capitalize}.llm-output .value{font-size:1.05rem;white-space:pre-wrap;overflow-wrap:anywhere}.llm-output .raw{opacity:.72;font-size:.85rem;margin:6px 0}.llm-output .field footer,.llm-output .field-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px}.llm-output .sources{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}.llm-output .source{background:#3157d522;color:#6688ff;border-radius:5px;padding:2px 6px}.llm-output .confidence{position:relative;display:inline-flex;width:86px;height:24px;align-items:center;justify-content:center;overflow:hidden;border-radius:999px;background:#8883;font-size:12px}.llm-output .confidence span{position:absolute;inset:0 auto 0 0;opacity:.3}.llm-output .confidence strong{position:relative}.llm-output .confidence.high span{background:#198754}.llm-output .confidence.medium span{background:#d9840d}.llm-output .confidence.low span{background:#c44545}.llm-output .claims,.llm-output .unmapped-list{display:grid;gap:12px}.llm-output .claim{padding:0}.llm-output .claim>header{display:flex;align-items:center;justify-content:space-between;margin:0;padding:14px;border-bottom:1px solid #8885}.llm-output .claim-number{opacity:.7;font-size:12px}.llm-output .claim-fields{gap:0}.llm-output .claim-field{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:14px;border-bottom:1px solid #8885}.llm-output .claim-field:nth-child(odd){border-right:1px solid #8885}.llm-output .claim>footer,.llm-output .unmapped-list article>footer{display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px}.llm-output .claim>footer span,.llm-output .current,.llm-output .tags span,.llm-output .review-issue{background:#8882;border-radius:999px;padding:3px 9px;font-size:12px}.llm-output .review-issue{color:#df6666}.llm-output .current{color:#20a66f;font-weight:700}.llm-output .tags,.llm-output .links{display:flex;flex-wrap:wrap;gap:6px}.llm-output .links{flex-direction:column}.llm-output .links span{display:flex;flex-direction:column}.llm-output .unmapped-list article header{display:flex;justify-content:space-between;gap:10px}.llm-output .unmapped-list article header span{color:#df6666;font-size:12px;text-transform:capitalize}.llm-output .empty,.llm-output .missing{opacity:.7;font-style:italic}@media(max-width:760px){.llm-output .profile-grid,.llm-output .claim-fields{grid-template-columns:1fr}.llm-output .claim-field:nth-child(odd){border-right:0}.llm-output .claim-field{grid-template-columns:1fr}}
`;

export function buildEmbeddedLlmInspectionReport(
  result: CandidateExtractionResult,
  providerOutput?: unknown
): string {
  return `<section class="llm-output"><h2>AI structured extraction</h2><p>Claims mapped from the LLM response, with field-level confidence and source evidence.</p>${inspectionSummary(
    result
  )}${inspectionSections(result, '', false)}<details><summary>Mapped extraction JSON</summary><pre>${escapeHtml(
    JSON.stringify(result, null, 2)
  )}</pre></details>${providerOutput === undefined ? '' : providerOutputDetails(
    providerOutput
  )}</section>`;
}

export function buildLlmInspectionReport(
  result: CandidateExtractionResult,
  input: string,
  providerOutput?: unknown
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LLM extraction inspection</title>
<style>
:root{color-scheme:light;--ink:#172033;--muted:#637083;--line:#dce2ea;--surface:#fff;--soft:#f5f7fa;--accent:#3157d5;--good:#18835a;--warn:#bd7411;--bad:#c44545}*{box-sizing:border-box}body{margin:0;background:#eef1f5;color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body>header,main{width:min(1180px,calc(100% - 32px));margin:auto}body>header{padding:42px 0 24px}h1,h2,h3,h4,p{margin-top:0}h1{font-size:clamp(28px,4vw,44px);letter-spacing:-.04em;margin-bottom:8px}h2{font-size:22px;margin-bottom:16px}h3{margin-bottom:4px}h4{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}.lede{color:var(--muted);font-size:17px}.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-top:24px}.summary div,.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 5px 20px #1720330a}.summary div{padding:14px;color:var(--muted);font-size:13px}.summary strong{display:block;color:var(--ink);font-size:24px}.summary code{font-size:12px;word-break:break-all}main{display:grid;gap:20px;padding-bottom:50px}.panel{padding:24px}.section-note{color:var(--muted);margin-top:-12px}.profile-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field,.claim,.unmapped-list article{border:1px solid var(--line);border-radius:10px;background:var(--surface)}.field{padding:16px}.field h3,.claim h3,.unmapped-list h3{text-transform:capitalize}.value{font-size:17px;white-space:pre-wrap;overflow-wrap:anywhere}.raw{color:var(--muted);font-size:13px;margin:7px 0 0}.field footer,.field-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.sources{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}.source{background:#edf1ff;color:#2948aa;border-radius:5px;padding:2px 6px}.confidence{position:relative;display:inline-flex;width:90px;height:25px;align-items:center;justify-content:center;overflow:hidden;border-radius:999px;background:#e9edf2;font-size:12px}.confidence span{position:absolute;inset:0 auto 0 0;opacity:.2}.confidence strong{position:relative}.confidence.high span{background:var(--good)}.confidence.medium span{background:var(--warn)}.confidence.low span{background:var(--bad)}.claims{display:grid;gap:14px}.claim>header{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--line)}.claim-number{color:var(--muted);font-size:12px}.claim-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.claim-field{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:15px;padding:16px 18px;border-bottom:1px solid var(--line)}.claim-field:nth-child(odd){border-right:1px solid var(--line)}.claim>footer,.unmapped-list article>footer{display:flex;flex-wrap:wrap;gap:7px;padding:12px 18px}.claim>footer span,.current,.tags span,.review-issue{background:var(--soft);border-radius:999px;padding:3px 9px;font-size:12px}.review-issue{color:var(--bad)}.current{color:var(--good);font-weight:700}.tags,.links{display:flex;flex-wrap:wrap;gap:6px}.links{flex-direction:column}.links span{display:flex;flex-direction:column}.links code{color:var(--muted);overflow-wrap:anywhere}.unmapped-list{display:grid;gap:10px}.unmapped-list article{padding:15px}.unmapped-list header{display:flex;justify-content:space-between;gap:12px}.unmapped-list header span{color:var(--bad);font-size:12px;text-transform:capitalize}.unmapped-list p{white-space:pre-wrap}.empty,.missing{color:var(--muted);font-style:italic}details{border-top:1px solid var(--line);padding-top:14px;margin-top:18px}summary{cursor:pointer;font-weight:700}pre{padding:16px;border-radius:9px;background:#111827;color:#dbeafe;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}@media(max-width:760px){.summary,.profile-grid,.claim-fields{grid-template-columns:1fr}.claim-field:nth-child(odd){border-right:0}.claim-field{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:18px}}
</style></head><body><header><h1>AI structured extraction</h1><p class="lede">Human-readable inspection of the claims mapped from the LLM response.</p>${inspectionSummary(
    result
  )}</header><main>${inspectionSections(result, input)}${
    providerOutput === undefined ? '' : `<section class="panel"><h2>Provider diagnostics</h2>${providerOutputDetails(providerOutput)}</section>`
  }</main></body></html>`;
}
