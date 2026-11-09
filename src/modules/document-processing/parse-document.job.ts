export const PARSE_DOCUMENT_JOB_VERSION = 1 as const;
export const PARSE_DOCUMENT_QUEUE = 'document-processing.parse-document';

export interface ParseDocumentJob {
  version: typeof PARSE_DOCUMENT_JOB_VERSION;
  jobId: string;
  documentId: string;
}
