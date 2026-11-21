import { describe, expect, it, vi } from 'vitest';
import type { LlmService } from '../../infrastructure/llm/llm.service.js';
import type { MergeCandidateClaim } from './candidates.claim-comparison.js';
import {
  createDuplicateJudge,
  DUPLICATE_JUDGMENT_TASK,
  haveCloseDateRanges
} from './candidates.duplicate-ai.js';

function claim(
  values: MergeCandidateClaim['values'],
  overrides: Partial<MergeCandidateClaim> = {}
): MergeCandidateClaim {
  return {
    claimId: '11111111-1111-4111-8111-111111111111',
    candidateId: '22222222-2222-4222-8222-222222222222',
    claimType: 'employment',
    version: 1,
    origin: 'extracted',
    status: 'pending',
    candidateEdited: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    values,
    ...overrides
  };
}

describe('close claim date ranges', () => {
  it('selects close employment and education ranges for AI judgment', () => {
    const employment = claim({
      employer: 'Example Labs',
      jobTitle: 'Engineer',
      startDate: '2020-01',
      endDate: '2024-01'
    });
    const closeEmployment = claim(
      {
        employer: 'Example Labs',
        jobTitle: 'Engineer',
        startDate: '2020-10',
        endDate: '2024-09'
      },
      { claimId: '33333333-3333-4333-8333-333333333333' }
    );
    const education = claim(
      { institution: 'Example University', degree: 'BSc', startDate: '2020', endDate: '2024' },
      { claimType: 'education' }
    );
    const closeEducation = claim(
      {
        institution: 'Example University',
        degree: 'BSc',
        startDate: '2021',
        endDate: '2025'
      },
      { claimId: '33333333-3333-4333-8333-333333333333', claimType: 'education' }
    );

    expect(haveCloseDateRanges(employment, closeEmployment)).toBe(true);
    expect(haveCloseDateRanges(education, closeEducation)).toBe(true);
  });

  it('does not spend AI calls on distant, incomplete, or unsupported ranges', () => {
    const base = claim({
      employer: 'Example Labs',
      jobTitle: 'Engineer',
      startDate: '2020-01',
      endDate: '2024-01'
    });
    expect(
      haveCloseDateRanges(
        base,
        claim(
          {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2022-01',
            endDate: '2026-01'
          },
          { claimId: '33333333-3333-4333-8333-333333333333' }
        )
      )
    ).toBe(false);
    expect(
      haveCloseDateRanges(
        base,
        claim(
          { employer: 'Example Labs', jobTitle: 'Engineer', startDate: '2020-02' },
          { claimId: '33333333-3333-4333-8333-333333333333' }
        )
      )
    ).toBe(false);
    expect(
      haveCloseDateRanges(base, claim(base.values, { claimType: 'project' }))
    ).toBe(false);
  });
});

describe('AI duplicate judge', () => {
  const left = claim({
    employer: 'Example Labs',
    jobTitle: 'Engineer',
    startDate: '2020-01',
    endDate: '2024-01'
  });
  const right = claim(
    {
      employer: 'Example Labs',
      jobTitle: 'Engineer',
      startDate: '2020-02',
      endDate: '2024-02'
    },
    { claimId: '33333333-3333-4333-8333-333333333333' }
  );

  function judgeWith(output: unknown) {
    const generate = vi.fn<LlmService['generate']>().mockResolvedValue({
      invocationId: '44444444-4444-4444-8444-444444444444',
      output
    });
    return {
      generate,
      judge: createDuplicateJudge({
        llmService: { generate },
        provider: 'gemini',
        model: 'flash-lite',
        timeoutMs: 1_000
      })
    };
  }

  it('accepts a confident merge-candidate decision', async () => {
    const { generate, judge } = judgeWith({
      canMerge: true,
      confidence: 0.91,
      reason: 'The dates are a minor source discrepancy.'
    });

    await expect(judge.judge(left, right)).resolves.toEqual({
      status: 'merge_candidate',
      confidence: 0.91,
      reason: 'The dates are a minor source discrepancy.'
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ task: DUPLICATE_JUDGMENT_TASK })
    );
  });

  it('accepts a confident different-record decision and rejects uncertain output', async () => {
    const different = judgeWith({
      canMerge: false,
      confidence: 0.95,
      reason: 'These are separate roles.'
    });
    await expect(different.judge.judge(left, right)).resolves.toEqual({
      status: 'different',
      confidence: 0.95,
      reason: 'These are separate roles.'
    });

    const uncertain = judgeWith({
      canMerge: false,
      confidence: 0.6,
      reason: 'The evidence is ambiguous.'
    });
    await expect(uncertain.judge.judge(left, right)).resolves.toEqual({
      status: 'uncertain',
      reason: 'The evidence is ambiguous.'
    });
  });
});
