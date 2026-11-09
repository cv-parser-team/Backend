export const PARSE_DOCUMENT_JOB_VERSION = 1 as const;
export const PARSE_DOCUMENT_QUEUE = 'document-processing.parse-document';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParseDocumentJob {
  version: typeof PARSE_DOCUMENT_JOB_VERSION;
  jobId: string;
  documentId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`Parse document job ${field} must be a valid UUID`);
  }
}

export function parseParseDocumentJob(message: unknown): ParseDocumentJob {
  if (!isRecord(message)) {
    throw new TypeError('Parse document job must be an object');
  }

  if (message.version !== PARSE_DOCUMENT_JOB_VERSION) {
    throw new TypeError('Unsupported parse document job version');
  }

  assertUuid(message.jobId, 'jobId');
  assertUuid(message.documentId, 'documentId');

  return {
    version: PARSE_DOCUMENT_JOB_VERSION,
    jobId: message.jobId,
    documentId: message.documentId
  };
}
