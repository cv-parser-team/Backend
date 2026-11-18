import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutTrace } from './layout.js';
import {
  type AdjudicationCase,
  type AdjudicationOption,
  toLayoutAdjudications
} from './parsing-adjudication.js';
import type { AdjudicationDecision, Adjudicator } from './parsing-adjudication.ai.js';
import { adjudicatePdfLayout } from './parsing-adjudication.run.js';

const cv = async (name: string) =>
  new Uint8Array(await readFile(new URL(`../../../manual-tests/documents/${name}`, import.meta.url)));

// An adjudicator that answers every case with `pick(case)`.
function answering(
  pick: (item: AdjudicationCase) => AdjudicationOption,
  source: AdjudicationDecision['source'] = 'ai'
): Adjudicator {
  return {
    adjudicate: vi.fn(async (cases: AdjudicationCase[]) => ({
      invocationId: 'i-1',
      failure: null,
      decisions: cases.map((item) => ({
        caseId: item.caseId,
        choice: pick(item),
        source,
        confidence: 0.9,
        reason: 'test'
      }))
    }))
  };
}

// Every reconstructed line has exactly one final owner and one reading
// position, whatever the AI decided.
function expectCompleteOwnership(trace: LayoutTrace): void {
  for (const page of trace.pages) {
    const owned = page.finalRegions.flatMap((region) => region.lineIndexes).sort((a, b) => a - b);
    const ordered = page.finalRegions
      .flatMap((region) => region.readingOrderLineIndexes)
      .sort((a, b) => a - b);
    const all = page.reconstructedLines.map((_, index) => index);
    expect(owned).toEqual(all);
    expect(ordered).toEqual(all);
  }
}

function boxes(trace: LayoutTrace) {
  return trace.pages.map((page) => page.reconstructedLines.map((line) => line.box));
}

describe('adjudicating a PDF layout', () => {
  it('keeps the deterministic layout when the AI agrees with it', async () => {
    const adjudicator = answering((item) => item.deterministic);

    const layout = await adjudicatePdfLayout(await cv('Arisha.pdf'), adjudicator, 'op-1');

    expect(layout.cases.length).toBeGreaterThan(0);
    expect(layout.adjudicated).toBe(layout.initial);
  });

  it.each(['Arisha.pdf', 'Eleanor.pdf'])(
    'keeps every line owned once and every coordinate unchanged when the AI disagrees: %s',
    async (name) => {
      const adjudicator = answering(
        (item) => item.options.find((option) => option !== item.deterministic)!
      );

      const layout = await adjudicatePdfLayout(await cv(name), adjudicator, 'op-1');

      expect(layout.adjudicated).not.toBe(layout.initial);
      expectCompleteOwnership(layout.adjudicated);
      expect(boxes(layout.adjudicated)).toEqual(boxes(layout.initial));
    }
  );

  it('confirms a heading the AI calls a section heading', async () => {
    const layout = await adjudicatePdfLayout(
      await cv('Arisha.pdf'),
      answering((item) => (item.kind === 'heading_role' ? 'section_heading' : item.deterministic)),
      'op-1'
    );

    const promoted = layout.cases.filter((item) => item.kind === 'heading_role');
    const page = layout.adjudicated.pages[0]!;
    for (const item of promoted) {
      const scope = page.sectionScopes.find(
        (candidate) => candidate.headingLineIndex === item.lineIndexes[0]
      );
      expect(scope?.status).toBe('confirmed');
      expect(scope?.reasons).toContain('AI adjudication: section heading');
    }
  });

  it('splits same-row headings the AI calls independent sections', async () => {
    const layout = await adjudicatePdfLayout(
      await cv('Arisha.pdf'),
      answering((item) =>
        item.kind === 'gutter_meaning' ? 'independent_sections' : item.deterministic
      ),
      'op-1'
    );

    const gutter = layout.cases.find((item) => item.kind === 'gutter_meaning')!;
    const scopes = layout.adjudicated.pages[0]!.sectionScopes.filter((scope) =>
      gutter.lineIndexes.includes(scope.headingLineIndex)
    );
    expect(scopes.map((scope) => [scope.status, scope.mode])).toEqual(
      gutter.lineIndexes.map(() => ['confirmed', 'lane-local'])
    );
  });

  it('ignores decisions that kept the deterministic choice', async () => {
    const adjudicator = answering(
      (item) => item.options.find((option) => option !== item.deterministic)!,
      'deterministic'
    );

    const layout = await adjudicatePdfLayout(await cv('Eleanor.pdf'), adjudicator, 'op-1');

    expect(layout.adjudicated).toBe(layout.initial);
  });

  it('does not ask the AI or rebuild when nothing is uncertain', async () => {
    const adjudicator = answering((item) => item.deterministic);

    const layout = await adjudicatePdfLayout(await cv('Alexander.pdf'), adjudicator, 'op-1');

    expect(layout.cases).toEqual([]);
    expect(layout.adjudicated).toBe(layout.initial);
  });
});

describe('turning AI choices into role overrides', () => {
  const item = (
    kind: AdjudicationCase['kind'],
    lineIndexes: number[],
    deterministic: AdjudicationOption
  ): AdjudicationCase => ({
    caseId: `${kind}:${lineIndexes.join(',')}`,
    kind,
    pageNumber: 2,
    lineIndexes,
    lineRefs: [],
    options: [],
    deterministic,
    context: []
  });

  it('maps each choice to its override and skips choices equal to the parser decision', () => {
    const cases = [
      item('heading_role', [1], 'content'),
      item('entry_boundary', [2], 'starts_entry'),
      item('gutter_meaning', [3, 4], 'shared_section'),
      item('gutter_meaning', [5, 6], 'shared_section'),
      item('heading_role', [7], 'entry_headline')
    ];
    const choices = new Map<string, AdjudicationOption>([
      ['heading_role:1', 'section_heading'],
      ['entry_boundary:2', 'continues_entry'],
      ['gutter_meaning:3,4', 'independent_sections'],
      ['gutter_meaning:5,6', 'metadata_rail'],
      ['heading_role:7', 'entry_headline']
    ]);

    expect(toLayoutAdjudications(cases, choices).get(2)).toEqual({
      confirmedHeadings: new Set([1]),
      continuingAnchors: new Set([2]),
      independentHeadings: new Set([3, 4]),
      notHeadings: new Set([5, 6])
    });
  });
});
