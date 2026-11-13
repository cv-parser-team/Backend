import { AppError } from '../../shared/errors/app.error.js';

// The output as a whole cannot be read, such as a wrong version or a missing
// claims list. Invalid individual items are returned as unmapped instead.
export class InvalidAiOutputError extends AppError {
  readonly statusCode = 422;
  readonly code = 'INVALID_AI_OUTPUT';
}

// A citation passed AI-input validation but cannot be linked uniquely to the
// stored parse result. This is an internal consistency failure, not evidence
// that should be silently discarded.
export class SourceReferenceResolutionError extends Error {
  readonly code = 'SOURCE_REFERENCE_RESOLUTION_FAILED';

  constructor(
    readonly missing: string[],
    readonly ambiguous: string[]
  ) {
    super('Claim source references could not be resolved uniquely');
    this.name = 'SourceReferenceResolutionError';
  }
}
