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
const PROCESSING_LEASE_MILLISECONDS = 5 * 60 * 1000;

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

    async republishQueuedJobs() {
      const jobs = await repository.listPublishableJobs(
        new Date(),
        QUEUED_JOB_REPUBLISH_BATCH_SIZE
      );
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
  };
}
