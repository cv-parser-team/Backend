import { AppError } from '../../shared/errors/app.error.js';

export class InvalidStorageKeyError extends Error {
  constructor() {
    super('Invalid document storage key');
    this.name = 'InvalidStorageKeyError';
  }
}

export class DocumentTooLargeError extends AppError {
  readonly statusCode = 413;
  readonly code = 'DOCUMENT_TOO_LARGE';

  constructor(readonly maximumByteSize: number) {
    super(`Document exceeds the ${maximumByteSize}-byte size limit`);
  }
}

export class InvalidDocumentUploadError extends AppError {
  readonly statusCode = 400;
  readonly code = 'INVALID_DOCUMENT_UPLOAD';

  constructor(message: string) {
    super(message);
  }
}

export class InvalidDocumentFilenameError extends AppError {
  readonly statusCode = 400;
  readonly code = 'INVALID_DOCUMENT_FILENAME';

  constructor() {
    super('Document filename must contain 1 to 255 Unicode characters');
  }
}

export class EmptyDocumentError extends AppError {
  readonly statusCode = 400;
  readonly code = 'EMPTY_DOCUMENT';

  constructor() {
    super('Document must not be empty');
  }
}

export class UnsupportedDocumentTypeError extends AppError {
  readonly statusCode = 400;
  readonly code = 'UNSUPPORTED_DOCUMENT_TYPE';

  constructor() {
    super('Document content does not match a supported file type');
  }
}

export class DocumentPurposeMismatchError extends AppError {
  readonly statusCode = 400;
  readonly code = 'DOCUMENT_PURPOSE_MISMATCH';

  constructor() {
    super('Document type is not supported for the selected purpose');
  }
}

export class CorruptedDocumentError extends AppError {
  readonly statusCode = 400;
  readonly code = 'CORRUPTED_DOCUMENT';

  constructor() {
    super('Document content is incomplete or structurally invalid');
  }
}
