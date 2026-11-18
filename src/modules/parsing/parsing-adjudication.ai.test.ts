import { describe, expect, it, vi } from 'vitest';
import { LlmError } from '../../infrastructure/llm/llm.errors.js';
import type { TrackedLlmRequest } from '../../infrastructure/llm/llm.service.js';
import { ADJUDICATION_OPTIONS, type AdjudicationCase } from './parsing-adjudication.js';
import {
  ADJUDICATION_TASK,
  buildAdjudicationInput,
  createAiAdjudicator
} from './parsing-adjudication.ai.js';

const heading: AdjudicationCase = {
  caseId: 'heading_role:p1-l12',
  kind: 'heading_role',
  pageNumber: 1,
  lineIndexes: [12],
  lineRefs: ['p1-l12'],
  options: ADJUDICATION_OPTIONS.heading_role,
  deterministic: 'entry_headline',
  context: ['p1-l11 [bold]: EDUCATION', 'p1-l12 [bold]: Master of Business Management', 'p1-l13: 2019 - 2021']
};

const gutter: AdjudicationCase = {
  caseId: 'gutter_meaning:p1-l46,p1-l48',
  kind: 'gutter_meaning',
  pageNumber: 1,
  lineIndexes: [46, 48],
  lineRefs: ['p1-l46', 'p1-l48'],
  options: ADJUDICATION_OPTIONS.gutter_meaning,
  deterministic: 'shared_section',
  context: ['p1-l45: REFERENCES', 'p1-l46 [bold]: Aarya Agarwal', 'p1-l48 [bold]: Sharin Varma']
};

function adjudicatorReturning(output: unknown) {
  const generate = vi.fn(async (_request: TrackedLlmRequest) => ({ invocationId: 'i-1', output }));
  const adjudicator = createAiAdjudicator({
    llmService: { generate },
    provider: 'gemini',
    model: 'test-model',
    timeoutMs: 5_000
  });
  return { adjudicator, generate };
}

describe('adjudication input', () => {
  it('numbers the cases and gives each its question, options, targets, and nearby lines', () => {
    const input = buildAdjudicationInput([heading, gutter]);

    expect(input).toContain('Case 1: Is the target line a section heading');
    expect(input).toContain('Options: section_heading | entry_headline | content');
    expect(input).toContain('Target: p1-l12');
    expect(input).toContain('p1-l12 [bold]: Master of Business Management');
    expect(input).toContain('Case 2: The target lines sit side by side.');
    expect(input).toContain('Target: p1-l46, p1-l48');
  });
});

describe('AI adjudicator', () => {
  it('applies confident choices from the options in one request', async () => {
    const { adjudicator, generate } = adjudicatorReturning({
      decisions: [
        { case: 1, choice: 'entry_headline', confidence: 0.95, reason: 'A degree under Education' },
        { case: 2, choice: 'independent_sections', confidence: 0.9, reason: 'Two reference cards' }
      ]
    });

    const result = await adjudicator.adjudicate([heading, gutter], 'operation-1');

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'operation-1',
        task: ADJUDICATION_TASK,
        input: buildAdjudicationInput([heading, gutter])
      })
    );
    expect(result).toEqual({
      invocationId: 'i-1',
      failure: null,
      decisions: [
        {
          caseId: heading.caseId,
          choice: 'entry_headline',
          source: 'ai',
          confidence: 0.95,
          reason: 'A degree under Education'
        },
        {
          caseId: gutter.caseId,
          choice: 'independent_sections',
          source: 'ai',
          confidence: 0.9,
          reason: 'Two reference cards'
        }
      ]
    });
  });

  it('keeps the parser decision for a missing, invalid, or unsure answer', async () => {
    const third: AdjudicationCase = { ...heading, caseId: 'heading_role:p1-l25', lineRefs: ['p1-l25'] };
    const { adjudicator } = adjudicatorReturning({
      decisions: [
        { case: 1, choice: 'job_title', confidence: 0.99, reason: 'Invented option' },
        { case: 2, choice: 'metadata_rail', confidence: 0.6, reason: 'Not sure' },
        { case: 9, choice: 'content', confidence: 0.99, reason: 'Unknown case' }
      ]
    });

    const { decisions } = await adjudicator.adjudicate([heading, gutter, third], 'operation-1');

    expect(decisions).toEqual([
      expect.objectContaining({ choice: 'entry_headline', source: 'deterministic', fallback: 'invalid_choice' }),
      expect.objectContaining({
        choice: 'shared_section',
        source: 'deterministic',
        fallback: 'low_confidence',
        confidence: 0.6
      }),
      expect.objectContaining({ choice: 'entry_headline', source: 'deterministic', fallback: 'no_answer' })
    ]);
  });

  it('keeps every parser decision when the output breaks the contract', async () => {
    const { adjudicator } = adjudicatorReturning({ decisions: [{ case: 1, choice: 'content' }] });

    const result = await adjudicator.adjudicate([heading, gutter], 'operation-1');

    expect(result.invocationId).toBe('i-1');
    expect(result.decisions.map((decision) => decision.fallback)).toEqual([
      'invalid_output',
      'invalid_output'
    ]);
  });

  it('keeps every parser decision when the AI request fails', async () => {
    const adjudicator = createAiAdjudicator({
      llmService: { generate: vi.fn().mockRejectedValue(new LlmError('busy', 'rate_limited')) },
      provider: 'gemini',
      model: 'test-model',
      timeoutMs: 5_000
    });

    const result = await adjudicator.adjudicate([heading], 'operation-1');

    expect(result).toEqual({
      invocationId: null,
      failure: 'rate_limited',
      decisions: [
        expect.objectContaining({ choice: 'entry_headline', source: 'deterministic', fallback: 'request_failed' })
      ]
    });
  });

  it('throws errors that are not provider failures', async () => {
    const failure = new Error('database unavailable');
    const adjudicator = createAiAdjudicator({
      llmService: { generate: vi.fn().mockRejectedValue(failure) },
      provider: 'gemini',
      model: 'test-model',
      timeoutMs: 5_000
    });

    await expect(adjudicator.adjudicate([heading], 'operation-1')).rejects.toBe(failure);
  });

  it('sends nothing when there is nothing uncertain', async () => {
    const { adjudicator, generate } = adjudicatorReturning({});

    await expect(adjudicator.adjudicate([], 'operation-1')).resolves.toEqual({
      decisions: [],
      invocationId: null,
      failure: null
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
