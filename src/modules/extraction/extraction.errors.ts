import { AppError } from '../../shared/errors/app.error.js';

// The output as a whole cannot be read, such as a wrong version or a missing
// claims list. Invalid individual items are returned as unmapped instead.
export class InvalidAiOutputError extends AppError {
  readonly statusCode = 422;
  readonly code = 'INVALID_AI_OUTPUT';
}
