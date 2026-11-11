import { describe, expect, it, vi } from 'vitest';
import {
  scheduleUploadedDocumentProcessing,
  type DocumentProcessingScheduler
} from './documents.routes.js';

const documentId = '22222222-2222-4222-8222-222222222222';

function createScheduler(): DocumentProcessingScheduler {
  return {
    schedule: vi.fn().mockResolvedValue(undefined)
  };
}

describe('document upload processing scheduling', () => {
  it('schedules a newly uploaded source document', async () => {
    const scheduler = createScheduler();

    await scheduleUploadedDocumentProcessing(
      scheduler,
      'source',
      documentId,
      false
    );

    expect(scheduler.schedule).toHaveBeenCalledWith(documentId);
  });

  it.each([
    { purpose: 'source' as const, deduplicated: true },
    { purpose: 'evidence' as const, deduplicated: false }
  ])(
    'does not schedule $purpose when deduplicated is $deduplicated',
    async ({ purpose, deduplicated }) => {
      const scheduler = createScheduler();

      await scheduleUploadedDocumentProcessing(
        scheduler,
        purpose,
        documentId,
        deduplicated
      );

      expect(scheduler.schedule).not.toHaveBeenCalled();
    }
  );

  it('propagates scheduling failures to the per-file upload boundary', async () => {
    const failure = new Error('processing unavailable');
    const scheduler = createScheduler();
    vi.mocked(scheduler.schedule).mockRejectedValue(failure);

    await expect(
      scheduleUploadedDocumentProcessing(
        scheduler,
        'source',
        documentId,
        false
      )
    ).rejects.toBe(failure);
  });
});
