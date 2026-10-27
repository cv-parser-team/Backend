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

export class ClaimTypeMismatchError extends AppError {
  readonly statusCode = 400;
  readonly code = 'CLAIM_TYPE_MISMATCH';

  constructor() {
    super('Claim type cannot be changed');
  }
}
