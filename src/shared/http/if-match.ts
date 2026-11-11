import { AppError } from '../errors/app.error.js';

export class InvalidIfMatchError extends AppError {
  readonly statusCode = 400;
  readonly code = 'INVALID_IF_MATCH';

  constructor() {
    super('If-Match must be a record version, such as "3"');
  }
}

// Accepts 3, "3", and W/"3". Weak validators are accepted because versions
// identify the stored record, not its exact bytes.
const IF_MATCH_PATTERN = /^(?:W\/)?"?([1-9]\d{0,9})"?$/;

// Returns the version the client last read, or undefined when the header is
// absent: until every client sends it, writes without it are not checked.
export function parseIfMatchVersion(
  header: string | string[] | undefined
): number | undefined {
  if (header === undefined) {
    return undefined;
  }

  const match = typeof header === 'string' ? IF_MATCH_PATTERN.exec(header.trim()) : null;
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    throw new InvalidIfMatchError();
  }

  return version;
}

export function versionEtag(version: number): string {
  return `"${version}"`;
}
