import { describe, expect, it, vi } from 'vitest';
import type { TrackedLlmRequest } from '../../infrastructure/llm/llm.service.js';
import {
  AI_MATCHING_TASK,
  type AiMatchingRequest,
  buildAiMatchingInput,
  createAiMatcher
} from './normalization.ai.js';
import type { DictionaryTerm } from './normalization.matching.js';

function term(termId: string, canonicalName: string): DictionaryTerm {
  return { termId, category: 'job_title', canonicalName, status: 'active', mergedIntoId: null };
}

const backend = term('t-be', 'Backend Developer');
const frontend = term('t-fe', 'Frontend Developer');

const request: AiMatchingRequest = {
  operationId: '11111111-1111-4111-8111-111111111111',
  category: 'job_title',
  value: 'Server-side Engineer',
  context: { employer: 'Aramex' },
  terms: [backend, frontend]
};

function matcherReturning(output: unknown) {
  const generate = vi.fn(async (_request: TrackedLlmRequest) => ({
    invocationId: 'i-1',
    output
  }));
  const matcher = createAiMatcher({
    llmService: { generate },
    provider: 'gemini',
    model: 'test-model',
    timeoutMs: 5_000
  });
  return { matcher, generate };
}

describe('AI matching input', () => {
  it('numbers the terms and includes the context', () => {
    expect(buildAiMatchingInput(request)).toBe(
      [
        'Kind: job title',
        'Value: Server-side Engineer',
        'Context:\nemployer: Aramex',
        'Terms:\n1. Backend Developer\n2. Frontend Developer'
      ].join('\n\n')
    );
  });

  it('says when there is no context', () => {
    expect(buildAiMatchingInput({ ...request, context: {} })).toContain('Context: none');
  });
});

describe('AI matcher', () => {
  it('links a confident choice from the list', async () => {
    const { matcher, generate } = matcherReturning({
      choice: 1,
      confidence: 0.92,
      reason: 'Server-side work is backend development'
    });

    await expect(matcher.match(request)).resolves.toEqual({
      status: 'matched',
      term: backend,
      confidence: 0.92,
      reason: 'Server-side work is backend development'
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: request.operationId,
        task: AI_MATCHING_TASK,
        model: 'test-model',
        input: buildAiMatchingInput(request)
      })
    );
  });

  it('leaves the value unmatched when the AI finds no term', async () => {
    const { matcher } = matcherReturning({ choice: 0, confidence: 0.9, reason: 'No match' });

    await expect(matcher.match(request)).resolves.toEqual({
      status: 'unmatched',
      reason: 'No match'
    });
  });

  it('leaves the value unmatched when the AI is not sure enough', async () => {
    const { matcher } = matcherReturning({ choice: 1, confidence: 0.84, reason: 'Maybe' });

    await expect(matcher.match(request)).resolves.toMatchObject({ status: 'unmatched' });
  });

  it.each([
    [{ choice: 3, confidence: 0.99, reason: 'Invented' }],
    [{ choice: 1, confidence: 1.5, reason: 'Too sure' }],
    [{ choice: 1, confidence: 0.9 }],
    [{ choice: 1.5, confidence: 0.9, reason: 'Half' }],
    [{ choice: 1, confidence: 0.9, reason: 'Extra', termId: 't-x' }],
    ['not an object']
  ])('rejects output that breaks the contract: %o', async (output) => {
    const { matcher } = matcherReturning(output);

    await expect(matcher.match(request)).resolves.toMatchObject({ status: 'invalid' });
  });

  it('does not call the AI when there are no terms', async () => {
    const { matcher, generate } = matcherReturning({});

    await expect(matcher.match({ ...request, terms: [] })).resolves.toMatchObject({
      status: 'unmatched'
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('lets provider errors reach the caller, which decides about retries', async () => {
    const failure = new Error('rate limited');
    const matcher = createAiMatcher({
      llmService: { generate: vi.fn().mockRejectedValue(failure) },
      provider: 'gemini',
      model: 'test-model',
      timeoutMs: 5_000
    });

    await expect(matcher.match(request)).rejects.toBe(failure);
  });
});
