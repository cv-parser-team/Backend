import { AppError } from '../../shared/errors/app.error.js';

export class AuthenticationError extends AppError {
  readonly statusCode = 401;
  readonly code = 'AUTHENTICATION_REQUIRED';
}

export class AuthorizationError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}
