import { AppError } from '../../shared/errors/app.error.js';

export class AuthenticationError extends AppError {
  readonly statusCode = 401;
  readonly code = 'AUTHENTICATION_REQUIRED';
}

export class InvalidCredentialsError extends AppError {
  readonly statusCode = 401;
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Invalid email or password');
  }
}

export class AuthorizationError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}

export class AccountUnavailableError extends AppError {
  readonly statusCode = 403;
  readonly code = 'ACCOUNT_UNAVAILABLE';
}
