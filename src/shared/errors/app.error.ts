export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class RecordNotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'RECORD_NOT_FOUND';

  constructor(entity: string, identifier?: string | number) {
    const idInfo = identifier === undefined ? '' : ` with identifier '${identifier}'`;
    super(`${entity}${idInfo} was not found`);
  }
}
