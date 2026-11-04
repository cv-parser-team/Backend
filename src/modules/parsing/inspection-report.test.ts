import { describe, expect, it } from 'vitest';
import { buildParsingInspectionReport } from './inspection-report.js';
import { ExtractionResult } from './parsing.types.js';

describe('parsing inspection report', () => {
  it('renders and escapes a positioned PDF result', () => {
    const result: ExtractionResult = {
      status: 'partial',
      format: 'pdf',
      pageCount: 2,
      pages: [{
        pageNumber: 1,
        width: 600,
        height: 800,
        regions: [{
          index: 0,
          box: { x: 50, y: 60, width: 500, height: 30 },
          confidence: 0.8,
          lines: [{
            order: 1,
            text: '<Sample & Candidate>',
            box: { x: 50, y: 60, width: 180, height: 20 },
            heading: true,
            bold: true,
            italic: false,
            bullet: false,
            links: []
          }]
        }]
      }],
      blocks: [],
      failures: [{ pageNumber: 2, code: 'NO_TEXT_LAYER' }],
      parserVersion: 'test@1.0.0'
    };

    const report = buildParsingInspectionReport(result, 'resume<script>.pdf');

    expect(report).toContain('resume&lt;script&gt;.pdf');
    expect(report).toContain('&lt;Sample &amp; Candidate&gt;');
    expect(report).toContain('left:8.333%');
    expect(report).toContain('## L1 &lt;Sample &amp; Candidate&gt;');
    expect(report).toContain('NO_TEXT_LAYER');
    expect(report).not.toContain('<script>');
  });
});
