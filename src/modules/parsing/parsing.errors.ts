import { AppError } from '../../shared/errors/app.error.js';

export class UnsupportedDocumentTypeError extends AppError {
  readonly statusCode = 415;
  readonly code = 'UNSUPPORTED_DOCUMENT_TYPE';

  constructor(mediaType: string) {
    super(`Documents of type '${mediaType}' cannot be parsed`);
  }
}
