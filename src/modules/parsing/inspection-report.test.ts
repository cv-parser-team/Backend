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
        metrics: {
          usualBodyHeight: 20,
          usualVerticalGap: 6,
          activeContentBox: traceLine.box,
          leftEdges: [{ value: 50, count: 1, share: 1 }],
          rightEdges: [{ value: 230, count: 1, share: 1 }],
          rowBaselines: [{ value: 70, count: 1, share: 1 }],
          heightClusters: [{ value: 20, count: 1, share: 1 }],
          styleClusters: [{ height: 20, bold: true, italic: false, count: 1, share: 1 }],
          verticalGutters: [],
          horizontalBands: [],
          separatorCoverage: [{ separatorIndex: 0, coverage: 1 }]
        },
        boundaryCandidates: [{
          lineIndex: 0,
          sectionKind: 'other',
          header: { score: 0.7, reasons: ['title-area prominence'] },
          section: { score: 0.8, reasons: ['bold typography'] },
          entry: { score: 0.4, reasons: ['compact anchor text'] },
          content: { score: 0.1, reasons: [] }
        }],
        nonTextBoundaryCandidates: [{
          kind: 'separator',
          box: { x: 40, y: 90, width: 220, height: 1 },
          evidence: { score: 0.75, reasons: ['thin relative to body text'] }
        }],
        layoutZoneCandidates: [{
          kind: 'full-width-section',
          box: traceLine.box,
          boundaryBox: { x: 40, y: 90, width: 220, height: 1 },
          confidence: 0.76,
          reasons: ['nearby horizontal evidence spans the active content width'],
          participatingLineIndexes: [0],
          parts: [{
            label: 'full-width-section',
            box: traceLine.box,
            lineIndexes: [0]
          }]
        }],
        sectionScopes: [{
          headingLineIndex: 0,
          kind: 'other',
          lineIndexes: [0],
          box: traceLine.box,
          status: 'confirmed',
          mode: 'cross-lane',
          confidence: 0.91,
          reasons: ['standalone full-width section hypothesis'],
          governingZoneCandidateIndexes: [0]
        }],
        entryAnchors: [],
        entryGroups: [],
        validatedZones: [],
        sectionColumns: [],
        finalRegions: [],
        revisedAiInputLines: []
      }]
    };

    const report = buildParsingInspectionReport(result, 'resume<script>.pdf', trace, {
      styles: '.embedded-claims{color:green}',
      content: '<section class="embedded-claims">Structured claims</section>'
    });

    expect(report).toContain('resume&lt;script&gt;.pdf');
    expect(report).toContain('&lt;Sample &amp; Candidate&gt;');
    expect(report).toContain('left:8.333%');
    expect(report).toContain('## L1 &lt;Sample &amp; Candidate&gt;');
    expect(report).toContain('NO_TEXT_LAYER');
    expect(report).toContain('Parsing levels');
    expect(report).toContain('1. Extracted pieces');
    expect(report).toContain('3. Page metrics');
    expect(report).toContain('4. Scored boundary candidates');
    expect(report).toContain('5. Provisional macro layout hypotheses');
    expect(report).toContain('6. Section scopes');
    expect(report).toContain('7. Entry groups');
    expect(report).toContain('8. Validated section columns');
    expect(report).toContain('9. Final ownership and reading order');
    expect(report).toContain('10. Revised compact AI input');
    expect(report).toContain('confirmed · cross-lane');
    expect(report).toContain('full-width-section');
    expect(report).toContain('Usual body height: <code>20</code>');
    expect(report).toContain('.embedded-claims{color:green}');
    expect(report).toContain('<section class="embedded-claims">Structured claims</section>');
    expect(report).toContain('1 active-content coverage');
    expect(report).toContain('title-area prominence');
    expect(report).toContain('entry candidate');
    expect(report).toContain('section-boundary');
    expect(report).toContain('horizontal separator');
    expect(report).toContain('Marks (1)');
    expect(report).not.toContain('<script>');
  });
});
