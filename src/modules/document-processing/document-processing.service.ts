import type { MessageBroker } from '../../infrastructure/messaging/message-broker.js';
import type {
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
  complete(job: ParseDocumentJob): Promise<ProcessingJobRecord | null>;
  retry(
    job: ParseDocumentJob,
    failureCode: string
  ): Promise<ProcessingJobRecord | null>;
  fail(
    job: ParseDocumentJob,
    failureCode: string
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

    complete(job) {
      return repository.completeJob({
        jobId: job.jobId,
        documentId: job.documentId
      });
    },

    async retry(job, failureCode) {
      return repository.retryJob({
        jobId: job.jobId,
        documentId: job.documentId,
        failureCode: normalizeFailureCode(failureCode),
        delayMilliseconds: PROCESSING_RETRY_DELAY_MILLISECONDS
      });
    },

    async fail(job, failureCode) {
      return repository.failJob({
        jobId: job.jobId,
        documentId: job.documentId,
        failureCode: normalizeFailureCode(failureCode)
      });
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
