import { describe, expect, it, vi } from 'vitest';
import type { DocumentRecord } from './documents.repository.js';
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

function uploaded(
  status: DocumentRecord['status'],
  purpose: DocumentRecord['purpose'] = 'source'
): Pick<DocumentRecord, 'documentId' | 'purpose' | 'status'> {
  return { documentId, purpose, status };
}

describe('document upload processing scheduling', () => {
  it.each(['stored', 'failed'] as const)(
    'schedules a %s source document, new or uploaded again',
    async (status) => {
      const scheduler = createScheduler();

      await scheduleUploadedDocumentProcessing(scheduler, uploaded(status));

      expect(scheduler.schedule).toHaveBeenCalledWith(documentId);
    }
  );

  it.each(['processing', 'ready', 'deleting'] as const)(
    'does not schedule a %s source document',
    async (status) => {
      const scheduler = createScheduler();

      await scheduleUploadedDocumentProcessing(scheduler, uploaded(status));

      expect(scheduler.schedule).not.toHaveBeenCalled();
    }
  );

  it('does not schedule evidence documents', async () => {
    const scheduler = createScheduler();

    await scheduleUploadedDocumentProcessing(scheduler, uploaded('stored', 'evidence'));

    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('propagates scheduling failures to the per-file upload boundary', async () => {
    const failure = new Error('processing unavailable');
    const scheduler = createScheduler();
    vi.mocked(scheduler.schedule).mockRejectedValue(failure);

    await expect(
      scheduleUploadedDocumentProcessing(scheduler, uploaded('stored'))
    ).rejects.toBe(failure);
  });
});
