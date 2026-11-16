import { describe, expect, it } from 'vitest';
import type { LayoutTrace } from './layout.js';
import { ADJUDICATION_OPTIONS, type AdjudicationCase } from './parsing-adjudication.js';
import { buildAdjudicationReport } from './parsing-adjudication.report.js';

const trace = {
  pages: [
    {
      pageNumber: 1,
      reconstructedLines: Array.from({ length: 50 }, (_, index) => ({
        text: index === 12 ? 'Master of <Business>' : index === 46 ? 'Aarya' : index === 48 ? 'Sharin' : ''
      }))
    }
  ]
} as unknown as LayoutTrace;

const heading: AdjudicationCase = {
  caseId: 'heading_role:p1-l12',
  kind: 'heading_role',
  pageNumber: 1,
  lineIndexes: [12],
  lineRefs: ['p1-l12'],
  options: ADJUDICATION_OPTIONS.heading_role,
  deterministic: 'entry_headline',
  context: []
};
const gutter: AdjudicationCase = {
  caseId: 'gutter_meaning:p1-l46,p1-l48',
  kind: 'gutter_meaning',
  pageNumber: 1,
  lineIndexes: [46, 48],
  lineRefs: ['p1-l46', 'p1-l48'],
  options: ADJUDICATION_OPTIONS.gutter_meaning,
  deterministic: 'shared_section',
  context: []
};

describe('AI adjudication report', () => {
  it('shows each case with the parser decision, the AI answer, and what was applied', () => {
    const html = buildAdjudicationReport(trace, [heading, gutter], {
      invocationId: 'i-1',
      failure: null,
      decisions: [
        { caseId: heading.caseId, choice: 'entry_headline', source: 'deterministic', confidence: 0.6, reason: 'Unsure', fallback: 'low_confidence' },
        { caseId: gutter.caseId, choice: 'independent_sections', source: 'ai', confidence: 0.9, reason: 'Two cards' }
      ]
    });

    expect(html).toContain('2 uncertain decisions, 1 AI choices applied');
    expect(html).toContain('Invocation: i-1');
    expect(html).toContain('p1-l12: Master of &lt;Business&gt;');
    expect(html).toContain('p1-l46: Aarya\np1-l48: Sharin');
    expect(html).toContain('Parser: entry_headline <small>(low_confidence)</small>');
    expect(html).toContain('AI: independent_sections');
    expect(html).toContain('Two cards');
  });

  it('says when the request failed and every parser decision was kept', () => {
    const html = buildAdjudicationReport(trace, [heading], {
      invocationId: null,
      failure: 'rate_limited',
      decisions: [
        { caseId: heading.caseId, choice: 'entry_headline', source: 'deterministic', confidence: null, reason: 'The AI request failed', fallback: 'request_failed' }
      ]
    });

    expect(html).toContain('the request failed (rate_limited), so every parser decision was kept');
  });

  it('says when nothing was uncertain', () => {
    expect(
      buildAdjudicationReport(trace, [], { decisions: [], invocationId: null, failure: null })
    ).toContain('No uncertain decisions; the AI was not asked.');
  });
});
