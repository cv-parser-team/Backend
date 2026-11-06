import { describe, expect, it } from 'vitest';
import { buildParsingInspectionReport } from './inspection-report.js';
import { LayoutTrace } from './layout.js';
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

    const traceLine = {
      text: '<Sample & Candidate>',
      box: { x: 50, y: 60, width: 180, height: 20 },
      heading: true,
      layoutAction: 'section-boundary' as const,
      bold: true,
      italic: false,
      bullet: false,
      links: []
    };
    const trace: LayoutTrace = {
      usualHeight: 12,
      usualGap: 4,
      pages: [{
        pageNumber: 1,
        width: 600,
        height: 800,
        pieces: [{
          text: '<Sample & Candidate>',
          box: traceLine.box,
          bold: true,
          italic: false,
          links: []
        }],
        marks: [{ x: 30, y: 64, width: 4, height: 4 }],
        separators: [{
          orientation: 'horizontal',
          box: { x: 40, y: 90, width: 220, height: 1 },
          thickness: 1
        }],
        reconstructedLines: [{
          text: traceLine.text,
          box: traceLine.box,
          bold: traceLine.bold,
          italic: traceLine.italic,
          bullet: traceLine.bullet,
          links: traceLine.links
        }],
        classifiedLines: [traceLine],
        splitRegions: [{ box: traceLine.box, confidence: 0.8, lines: [traceLine] }],
        ownedRegions: [{ box: traceLine.box, confidence: 0.8, lines: [traceLine] }]
      }]
    };

    const report = buildParsingInspectionReport(result, 'resume<script>.pdf', trace);

    expect(report).toContain('resume&lt;script&gt;.pdf');
    expect(report).toContain('&lt;Sample &amp; Candidate&gt;');
    expect(report).toContain('left:8.333%');
    expect(report).toContain('## L1 &lt;Sample &amp; Candidate&gt;');
    expect(report).toContain('NO_TEXT_LAYER');
    expect(report).toContain('Parsing levels');
    expect(report).toContain('1. Extracted pieces');
    expect(report).toContain('3. Classified boundaries');
    expect(report).toContain('entry boundary');
    expect(report).toContain('section-boundary');
    expect(report).toContain('horizontal separator');
    expect(report).toContain('Marks (1)');
    expect(report).not.toContain('<script>');
  });
});
