import { describe, expect, it } from 'vitest';
import type { CandidateExtractionResult } from './extraction.service.js';
import {
  buildEmbeddedLlmInspectionReport,
  buildLlmInspectionReport,
  EMBEDDED_LLM_INSPECTION_STYLES
} from './inspection-report.js';

describe('LLM inspection report', () => {
  it('renders structured claims, confidence, sources, and escaped evidence', () => {
    const result: CandidateExtractionResult = {
      invocationId: 'invocation-<one>',
      version: 1,
      profile: {
        values: {
          fullName: '<Samira & Haddad>',
          profileLinks: [{ label: 'Portfolio', url: 'https://example.com/?a=1&b=2' }]
        },
        rawValues: {},
        confidence: { fullName: 0.99, profileLinks: 0.8 },
        sources: { fullName: ['L1'], profileLinks: ['L2'] }
      },
      claims: [{
        type: 'employment',
        origin: 'extracted',
        status: 'pending',
        confidence: 0.72,
        fieldConfidence: { employer: 0.95, jobTitle: 0.72, startDate: 0.9, endDate: 0.88 },
        current: true,
        values: {
          employer: 'Example Labs',
          jobTitle: 'Backend <Engineer>',
          startDate: '2022-01',
          skills: ['TypeScript', 'PostgreSQL']
        },
        rawValues: { startDate: 'January 2022', endDate: 'Present' },
        sources: ['L5', 'L6'],
        fieldSources: {
          employer: ['L5'],
          jobTitle: ['L5'],
          startDate: ['L6'],
          endDate: ['L6'],
          skills: ['L7']
        }
      }],
      reviewItems: [{
        claimType: 'education',
        fields: {
          institution: { value: 'Example University', confidence: 0.9, sources: ['L20'] }
        },
        issues: [{ field: 'startDate', code: 'missing_start_date', required: true }],
        sources: ['L20'],
        fingerprint: 'review-fingerprint'
      }],
      unmapped: [{
        label: 'Awards',
        text: '<Engineering Excellence>',
        sources: ['L11'],
        reason: 'unsupported_section'
      }]
    };

    const report = buildLlmInspectionReport(result, 'L1 <Samira & Haddad>');

    expect(report).toContain('AI structured extraction');
    expect(report).toContain('Structured claims');
    expect(report).toContain('Claims needing review');
    expect(report).toContain('missing start date');
    expect(report).toContain('employment');
    expect(report).toContain('Backend &lt;Engineer&gt;');
    expect(report).toContain('<strong>72%</strong>');
    expect(report).toContain('<code class="source">L6</code>');
    expect(report).toContain('<span class="current">Current</span>');
    expect(report).toContain('January 2022');
    expect(report).toContain('unsupported section');
    expect(report).toContain('L1 &lt;Samira &amp; Haddad&gt;');
    expect(report).toContain('https://example.com/?a=1&amp;b=2');
    expect(report).not.toContain('<Samira & Haddad>');
    expect(report).not.toContain('<Engineering Excellence>');

    const providerOutput = { version: 1, claims: [{ unsafe: '<script>' }] };
    const embedded = buildEmbeddedLlmInspectionReport(result, providerOutput);
    expect(embedded).toContain('class="llm-output"');
    expect(embedded).toContain('Backend &lt;Engineer&gt;');
    expect(embedded).not.toContain('Evidence input');
    expect(embedded).toContain('Provider structured output');
    expect(embedded).toContain('&lt;script&gt;');
    expect(embedded).not.toContain('<script>');
    expect(EMBEDDED_LLM_INSPECTION_STYLES).toContain('.llm-output .claim');
  });

  it('shows explicit empty states', () => {
    const result: CandidateExtractionResult = {
      invocationId: 'invocation-2',
      version: 1,
      profile: { values: {}, rawValues: {}, confidence: {}, sources: {} },
      claims: [],
      reviewItems: [],
      unmapped: []
    };

    const report = buildLlmInspectionReport(result, 'L1 Empty');

    expect(report).toContain('No structured profile fields were extracted.');
    expect(report).toContain('No valid structured claims were extracted.');
    expect(report).toContain('Nothing was left unmapped.');
  });
});
