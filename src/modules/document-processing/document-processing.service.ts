import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import type { MessageBroker } from '../../infrastructure/messaging/message-broker.js';
import type {
  ClaimedProcessingJob,
  DocumentProcessingRepository,
  ProcessingJobRecord
} from './document-processing.repository.js';
import {
  PARSE_DOCUMENT_JOB_VERSION,
  PARSE_DOCUMENT_QUEUE
} from './parse-document.job.js';
import type { ParseDocumentJob } from './parse-document.job.js';

const QUEUED_JOB_REPUBLISH_BATCH_SIZE = 100;
const RETRY_RELEASE_BATCH_SIZE = 100;
const LEASE_RECOVERY_BATCH_SIZE = 100;
const PROCESSING_LEASE_MILLISECONDS = 5 * 60 * 1000;
const PROCESSING_RETRY_DELAY_MILLISECONDS = 30 * 1000;

export interface RepublishFailure {
  jobId: string;
  error: unknown;
}

export interface RepublishResult {
  published: number;
  failures: RepublishFailure[];
}

export interface DocumentProcessingService {
  schedule(documentId: string): Promise<ParseDocumentJob>;
  claim(job: ParseDocumentJob): Promise<ProcessingJobRecord | null>;
  // Locks the job in the transaction while the claim still owns it; returns
  // null otherwise.
  lockClaim(
    claimedJob: ClaimedProcessingJob,
    transaction: DatabaseExecutor
  ): Promise<ProcessingJobRecord | null>;
  // These finish the job only while the given claim still owns it, and return
  // null otherwise.
  complete(
    claimedJob: ClaimedProcessingJob,
    transaction?: DatabaseExecutor
  ): Promise<ProcessingJobRecord | null>;
  retry(
    claimedJob: ClaimedProcessingJob,
    failureCode: string,
    transaction?: DatabaseExecutor
  ): Promise<ProcessingJobRecord | null>;
  fail(
    claimedJob: ClaimedProcessingJob,
    failureCode: string,
    transaction?: DatabaseExecutor
  ): Promise<ProcessingJobRecord | null>;
  releaseAvailableRetries(): Promise<ProcessingJobRecord[]>;
  recoverExpiredLeases(): Promise<ProcessingJobRecord[]>;
  publishAvailableRetries(): Promise<RepublishResult>;
  publishRecoveredLeases(): Promise<RepublishResult>;
  republishQueuedJobs(): Promise<RepublishResult>;
}

export interface DocumentProcessingServiceDependencies {
  broker: MessageBroker;
  repository: DocumentProcessingRepository;
}

function toParseDocumentJob(job: ProcessingJobRecord): ParseDocumentJob {
  return {
    version: PARSE_DOCUMENT_JOB_VERSION,
    jobId: job.jobId,
    documentId: job.documentId
  };
}

// Callers may pass the whole claimed job record; only the claim is sent on.
function toClaim({
  jobId,
  documentId,
  attemptCount
}: ClaimedProcessingJob): ClaimedProcessingJob {
  return { jobId, documentId, attemptCount };
}

function normalizeFailureCode(failureCode: string): string {
  const normalizedFailureCode = failureCode.trim();

  if (!normalizedFailureCode) {
    throw new Error('Processing job failure code is required');
  }

  return normalizedFailureCode;
}

async function publishJobs(
  broker: MessageBroker,
  jobs: ProcessingJobRecord[]
): Promise<RepublishResult> {
  const failures: RepublishFailure[] = [];
  let published = 0;

  for (const job of jobs) {
    try {
      await broker.publish(PARSE_DOCUMENT_QUEUE, toParseDocumentJob(job));
      published += 1;
    } catch (error) {
      failures.push({ jobId: job.jobId, error });
    }
  }

  return { published, failures };
}

export function createDocumentProcessingService({
  broker,
  repository
}: DocumentProcessingServiceDependencies): DocumentProcessingService {
  return {
    async schedule(documentId) {
      const createdJob = await repository.createQueuedJob(documentId);
      const message = toParseDocumentJob(createdJob);

      await broker.publish(PARSE_DOCUMENT_QUEUE, message);

      return message;
    },

    claim(job) {
      return repository.claimJob({
        jobId: job.jobId,
        documentId: job.documentId,
        leaseMilliseconds: PROCESSING_LEASE_MILLISECONDS
      });
    },

    lockClaim(claimedJob, transaction) {
      return repository.lockClaimedJob(toClaim(claimedJob), transaction);
    },

    complete(claimedJob, transaction) {
      return repository.completeJob(toClaim(claimedJob), transaction);
    },

    async retry(claimedJob, failureCode, transaction) {
      return repository.retryJob(
        {
          ...toClaim(claimedJob),
          failureCode: normalizeFailureCode(failureCode),
          delayMilliseconds: PROCESSING_RETRY_DELAY_MILLISECONDS
        },
        transaction
      );
    },

    async fail(claimedJob, failureCode, transaction) {
      return repository.failJob(
        {
          ...toClaim(claimedJob),
          failureCode: normalizeFailureCode(failureCode)
        },
        transaction
      );
    },

    releaseAvailableRetries() {
      return repository.releaseAvailableRetries(
        new Date(),
        RETRY_RELEASE_BATCH_SIZE
      );
    },

    recoverExpiredLeases() {
      return repository.releaseExpiredLeases(
        new Date(),
        LEASE_RECOVERY_BATCH_SIZE
      );
    },

    async publishAvailableRetries() {
      const jobs = await repository.releaseAvailableRetries(
        new Date(),
        RETRY_RELEASE_BATCH_SIZE
      );

      return publishJobs(broker, jobs);
    },

    async publishRecoveredLeases() {
      const jobs = await repository.releaseExpiredLeases(
        new Date(),
        LEASE_RECOVERY_BATCH_SIZE
      );

      return publishJobs(broker, jobs);
    },

    async republishQueuedJobs() {
      const jobs = await repository.listPublishableJobs(
        new Date(),
        QUEUED_JOB_REPUBLISH_BATCH_SIZE
      );

      return publishJobs(broker, jobs);
    }
  };
}
