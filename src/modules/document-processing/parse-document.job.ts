export const PARSE_DOCUMENT_JOB_VERSION = 1 as const;

export interface ParseDocumentJob {
  version: typeof PARSE_DOCUMENT_JOB_VERSION;
  jobId: string;
  documentId: string;
}
