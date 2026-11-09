import { describe, expect, it } from 'vitest';
import {
  PARSE_DOCUMENT_JOB_VERSION,
  parseParseDocumentJob
} from './parse-document.job.js';

const validJob = {
  version: PARSE_DOCUMENT_JOB_VERSION,
  jobId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222'
};

describe('parse document job', () => {
  it('parses a valid versioned job', () => {
    expect(parseParseDocumentJob(validJob)).toEqual(validJob);
  });

  it.each([null, undefined, 'job', 1, [], true])(
    'rejects non-object payload %j',
    (message) => {
      expect(() => parseParseDocumentJob(message)).toThrow(
        'Parse document job must be an object'
      );
    }
  );

  it('rejects unsupported and missing versions', () => {
    expect(() =>
      parseParseDocumentJob({ ...validJob, version: 2 })
    ).toThrow('Unsupported parse document job version');
    expect(() =>
      parseParseDocumentJob({
        jobId: validJob.jobId,
        documentId: validJob.documentId
      })
    ).toThrow('Unsupported parse document job version');
  });

  it.each([
    ['jobId', 'not-a-uuid'],
    ['jobId', undefined],
    ['documentId', 'not-a-uuid'],
    ['documentId', undefined]
  ] as const)('rejects invalid %s values', (field, value) => {
    expect(() =>
      parseParseDocumentJob({ ...validJob, [field]: value })
    ).toThrow(`Parse document job ${field} must be a valid UUID`);
  });

  it('returns only fields from the job contract', () => {
    expect(
      parseParseDocumentJob({ ...validJob, storagePath: '/private/resume.pdf' })
    ).toEqual(validJob);
  });
});
