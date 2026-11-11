import { AppError } from '../../shared/errors/app.error.js';

export class DatabaseError extends AppError {
  readonly statusCode: number = 500;
  readonly code: string = 'DATABASE_ERROR';
}

export class DatabaseConnectionError extends DatabaseError {
  override readonly statusCode = 503;
  override readonly code = 'DATABASE_UNAVAILABLE';

  constructor(
    message = 'Database connection unavailable. Ensure the database server is running.',
    details?: unknown
  ) {
    super(message, details);
  }
}

// A failure caused by another transaction at the same moment, such as a
// deadlock. Running the same work again usually succeeds.
export class TransientDatabaseError extends DatabaseError {
  override readonly statusCode = 503;
  override readonly code = 'TRANSIENT_DATABASE_ERROR';

  constructor(
    message = 'The database was busy with a conflicting operation. Try again.',
    details?: unknown
  ) {
    super(message, details);
  }
}

const TRANSIENT_DRIVER_CODES = new Set([
  '40001',
  '40P01',
  '55P03',
  'ECONNREFUSED',
  '57P01',
  '57P02',
  '57P03'
]);

// Errors worth retrying: concurrent conflicts and a lost connection. Driver
// errors are recognized too, because a transaction can fail while committing,
// before any repository maps the error.
export function isTransientDatabaseError(error: unknown): boolean {
  if (
    error instanceof TransientDatabaseError ||
    error instanceof DatabaseConnectionError
  ) {
    return true;
  }

  if (error instanceof AppError || !isDatabaseDriverError(error)) {
    return false;
  }

  return error.code !== undefined && TRANSIENT_DRIVER_CODES.has(error.code);
}

export class UniqueConstraintViolationError extends DatabaseError {
  override readonly statusCode = 409;
  override readonly code = 'UNIQUE_CONSTRAINT_VIOLATION';
}

export class ForeignKeyViolationError extends DatabaseError {
  override readonly statusCode = 400;
  override readonly code = 'FOREIGN_KEY_VIOLATION';
}

export class NotNullViolationError extends DatabaseError {
  override readonly statusCode = 400;
  override readonly code = 'NOT_NULL_VIOLATION';
}

interface DatabaseDriverError {
  code?: string;
  message?: string;
}

function isDatabaseDriverError(error: unknown): error is DatabaseDriverError {
  return typeof error === 'object' && error !== null;
}

export function mapDatabaseError(error: unknown, entityName = 'Record'): never {
  if (error instanceof AppError) {
    throw error;
  }

  const driverError = isDatabaseDriverError(error) ? error : undefined;

  switch (driverError?.code) {
    case '23505':
      throw new UniqueConstraintViolationError(
        `${entityName} already exists with the provided unique information.`,
        driverError
      );
    case '23503':
      throw new ForeignKeyViolationError(
        `${entityName} references a non-existent related record.`,
        driverError
      );
    case '23502':
      throw new NotNullViolationError(
        `A required field is missing for ${entityName}.`,
        driverError
      );
    case '40001':
    case '40P01':
    case '55P03':
      throw new TransientDatabaseError(undefined, driverError);
    case 'ECONNREFUSED':
    case '57P01':
    case '57P02':
    case '57P03':
      throw new DatabaseConnectionError(
        'Database connection failed. Ensure the database service is reachable.',
        driverError
      );
    default:
      throw new DatabaseError(
        driverError?.message || 'An unexpected database error occurred',
        driverError
      );
  }
}

export async function withDbErrors<T>(
  entityName: string,
  operation: () => Promise<T>
): Promise<T>;
export async function withDbErrors<T>(operation: () => Promise<T>): Promise<T>;
export async function withDbErrors<T>(
  entityOrOperation: string | (() => Promise<T>),
  suppliedOperation?: () => Promise<T>
): Promise<T> {
  const entityName = typeof entityOrOperation === 'string' ? entityOrOperation : 'Record';
  const operation =
    typeof entityOrOperation === 'function' ? entityOrOperation : suppliedOperation;

  if (!operation) {
    throw new DatabaseError('A database operation was not supplied');
  }

  try {
    return await operation();
  } catch (error) {
    return mapDatabaseError(error, entityName);
  }
}
