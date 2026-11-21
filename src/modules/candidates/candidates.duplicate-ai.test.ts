import { describe, expect, it, vi } from 'vitest';
import { LlmError } from '../../infrastructure/llm/llm.errors.js';
import type { LlmService } from '../../infrastructure/llm/llm.service.js';
import type { MergeCandidateClaim } from './candidates.claim-comparison.js';
import {
  createDuplicateJudge,
  DUPLICATE_JUDGMENT_RETRY_DELAYS_MS,
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

  it('treats a current role as running until its source date or now', () => {
    const asOf = new Date('2026-11-15T00:00:00.000Z');
    const current = claim(
      { employer: 'Northstar Labs', jobTitle: 'Backend Engineer', startDate: '2022-01' },
      { current: true }
    );
    const otherCurrent = claim(
      { employer: 'Northstar Labs', jobTitle: 'Server-Side Engineer', startDate: '2022-02' },
      { claimId: '33333333-3333-4333-8333-333333333333', current: true }
    );
    const endedRecently = claim(
      {
        employer: 'Northstar Labs',
        jobTitle: 'Backend Engineer',
        startDate: '2022-01',
        endDate: '2026-06'
      },
      { claimId: '33333333-3333-4333-8333-333333333333' }
    );
    const endedLongAgo = claim(
      {
        employer: 'Northstar Labs',
        jobTitle: 'Backend Engineer',
        startDate: '2022-01',
        endDate: '2023-01'
      },
      { claimId: '33333333-3333-4333-8333-333333333333' }
    );

    expect(haveCloseDateRanges(current, otherCurrent, asOf)).toBe(true);
    expect(haveCloseDateRanges(current, endedRecently, asOf)).toBe(true);
    expect(haveCloseDateRanges(current, endedLongAgo, asOf)).toBe(false);
    expect(
      haveCloseDateRanges(
        { ...current, currentAsOf: '2023-01' },
        endedLongAgo,
        asOf
      )
    ).toBe(true);
  });

  it('compares education by the graduation date when neither gives a start', () => {
    const graduated = claim(
      { institution: 'UC Berkeley', degree: 'BSc', endDate: '2020-05' },
      { claimType: 'education' }
    );
    const graduatedSoonAfter = claim(
      { institution: 'University of California, Berkeley', degree: 'BSc', endDate: '2020-09' },
      { claimId: '33333333-3333-4333-8333-333333333333', claimType: 'education' }
    );
    const graduatedLater = claim(
      { institution: 'UC Berkeley', degree: 'BSc', endDate: '2023-05' },
      { claimId: '33333333-3333-4333-8333-333333333333', claimType: 'education' }
    );
    const withStart = claim(
      { institution: 'UC Berkeley', degree: 'BSc', startDate: '2016-09', endDate: '2020-05' },
      { claimId: '33333333-3333-4333-8333-333333333333', claimType: 'education' }
    );
    const undated = claim(
      { institution: 'UC Berkeley', degree: 'BSc' },
      { claimId: '33333333-3333-4333-8333-333333333333', claimType: 'education' }
    );

    expect(haveCloseDateRanges(graduated, graduatedSoonAfter)).toBe(true);
    expect(haveCloseDateRanges(graduated, graduatedLater)).toBe(false);
    // A start date only one record gives leaves the ranges incomparable.
    expect(haveCloseDateRanges(graduated, withStart)).toBe(false);
    // Records without any date have no range to compare.
    expect(haveCloseDateRanges(undated, { ...undated })).toBe(false);
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

  describe('retries', () => {
    const answer = {
      invocationId: '44444444-4444-4444-8444-444444444444',
      output: { canMerge: true, confidence: 0.9, reason: 'The same role.' }
    };
    const judgeWithFailures = (generate: ReturnType<typeof vi.fn<LlmService['generate']>>) => {
      const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();
      return {
        sleep,
        judge: createDuplicateJudge({
          llmService: { generate },
          provider: 'gemini',
          model: 'flash-lite',
          timeoutMs: 1_000,
          sleep
        })
      };
    };

    it.each(['provider_unavailable', 'rate_limited', 'timeout'] as const)(
      'asks again after a temporary %s failure',
      async (category) => {
        const generate = vi
          .fn<LlmService['generate']>()
          .mockRejectedValueOnce(new LlmError('Model unavailable', category))
          .mockRejectedValueOnce(new LlmError('Model unavailable', category))
          .mockResolvedValue(answer);
        const { judge, sleep } = judgeWithFailures(generate);

        await expect(judge.judge(left, right)).resolves.toMatchObject({
          status: 'merge_candidate'
        });
        expect(generate).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls).toEqual(
          DUPLICATE_JUDGMENT_RETRY_DELAYS_MS.map((delay) => [delay])
        );
      }
    );

    it('gives up after the last retry', async () => {
      const failure = new LlmError('Model unavailable', 'provider_unavailable');
      const generate = vi.fn<LlmService['generate']>().mockRejectedValue(failure);
      const { judge } = judgeWithFailures(generate);

      await expect(judge.judge(left, right)).rejects.toBe(failure);
      expect(generate).toHaveBeenCalledTimes(DUPLICATE_JUDGMENT_RETRY_DELAYS_MS.length + 1);
    });

    it('does not retry failures that will not pass with time', async () => {
      const failure = new LlmError('Bad key', 'authentication');
      const generate = vi.fn<LlmService['generate']>().mockRejectedValue(failure);
      const { judge, sleep } = judgeWithFailures(generate);

      await expect(judge.judge(left, right)).rejects.toBe(failure);
      expect(generate).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
