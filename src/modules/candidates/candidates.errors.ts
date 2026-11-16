import { AppError } from '../../shared/errors/app.error.js';

export class CandidateProfileExistsError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CANDIDATE_PROFILE_EXISTS';

  constructor() {
    super('Candidate profile already exists');
  }
}

export class InvalidClaimDatesError extends AppError {
  readonly statusCode = 400;
  readonly code = 'INVALID_CLAIM_DATES';
}

export class InvalidClaimValuesError extends AppError {
  readonly statusCode = 400;
  readonly code = 'INVALID_CLAIM_VALUES';

  constructor(details: unknown) {
    super('Claim values do not match the claim type', details);
  }
}

// The record changed after the client read it. `details.current` holds the
// record as it is now, so the client can show the change and let the person
// decide; nothing was overwritten.
export class VersionConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'VERSION_CONFLICT';

  constructor(entity: string, current: unknown) {
    super(`${entity} was changed by another request. Reload it and try again`, {
      current
    });
  }
}

export class ClaimTypeMismatchError extends AppError {
  readonly statusCode = 400;
  readonly code = 'CLAIM_TYPE_MISMATCH';

  constructor() {
    super('Claim type cannot be changed');
  }
}

export class ClaimNotReviewableError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CLAIM_NOT_REVIEWABLE';

  constructor(current: unknown) {
    super('Only pending extracted claims can be reviewed', { current });
  }
}

export class OverlappingBatchClaimsError extends AppError {
  readonly statusCode = 400;
  readonly code = 'OVERLAPPING_BATCH_CLAIMS';

  constructor(claimIds: string[]) {
    super('A claim can appear in only one batch action', { claimIds });
  }
}
