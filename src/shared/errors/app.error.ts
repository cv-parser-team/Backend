export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  readonly isOperational: boolean = true;
  readonly details?: unknown; // internal only, never sent to the client

  constructor(
    message: string,
    options?: { details?: unknown; cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.details = options?.details;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Message that is safe to show to the client */
  get publicMessage(): string {
    return this.message;
  }

  toPublicJSON() {
    return { code: this.code, message: this.publicMessage };
  }
}

function sanitize(value: string | number): string {
  return String(value).replace(/[\r\n\t]/g, ' ').slice(0, 100);
}

export class RecordNotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'RECORD_NOT_FOUND';

  constructor(
    private readonly entity: string,
    identifier?: string | number | null,
    options?: { cause?: unknown }
  ) {
    const idInfo = identifier == null ? '' : ` with identifier '${sanitize(identifier)}'`;
    super(`${entity}${idInfo} was not found`, options);
  }

  // The client doesn't need the identifier or internal details
  override get publicMessage(): string {
    return `${this.entity} was not found`;
  }
}