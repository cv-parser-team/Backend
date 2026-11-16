import type { LayoutTrace } from './layout.js';
import {
  type AdjudicationCase,
  collectAdjudicationCases,
  toLayoutAdjudications
} from './parsing-adjudication.js';
import type { AdjudicationResult, Adjudicator } from './parsing-adjudication.ai.js';
import { createPdfParser } from './pdf-parser.js';

export interface AdjudicatedLayout {
  // The deterministic layout, before any AI decision.
  initial: LayoutTrace;
  // The layout rebuilt with the applied AI decisions; the initial layout when
  // none was applied.
  adjudicated: LayoutTrace;
  cases: AdjudicationCase[];
  result: AdjudicationResult;
}

async function traceOf(
  content: Uint8Array,
  adjudications?: ReturnType<typeof toLayoutAdjudications>
): Promise<LayoutTrace> {
  let trace: LayoutTrace | undefined;
  await createPdfParser({ onLayoutTrace: (built) => (trace = built), adjudications }).parse(content);
  if (!trace) {
    throw new Error('The PDF produced no layout trace');
  }
  return trace;
}

// Parses a PDF, asks the AI about its uncertain decisions in one request, and
// rebuilds the layout with the confident answers. Geometry, ownership, and
// reading order of the rebuilt layout come from the deterministic pipeline.
export async function adjudicatePdfLayout(
  content: Uint8Array,
  adjudicator: Adjudicator,
  operationId: string
): Promise<AdjudicatedLayout> {
  const initial = await traceOf(content);
  const cases = collectAdjudicationCases(initial);
  const result = await adjudicator.adjudicate(cases, operationId);
  const choices = new Map(
    result.decisions
      .filter((decision) => decision.source === 'ai')
      .map((decision) => [decision.caseId, decision.choice])
  );
  const adjudications = toLayoutAdjudications(cases, choices);
  const adjudicated = adjudications.size > 0 ? await traceOf(content, adjudications) : initial;

  return { initial, adjudicated, cases, result };
}
