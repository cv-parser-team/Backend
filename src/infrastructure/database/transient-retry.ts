import { setTimeout as sleep } from 'node:timers/promises';
import { isTransientDatabaseError } from './database.errors.js';

const DEFAULT_ATTEMPTS = 3;
const MINIMUM_DELAY_MILLISECONDS = 20;
const DELAY_SPREAD_MILLISECONDS = 80;

export interface TransientRetryOptions {
  attempts?: number;
  // Replaced in tests so they do not wait.
  wait?: (milliseconds: number) => Promise<unknown>;
}

// Runs the operation again when it fails with a transient database error, such
// as a deadlock, up to `attempts` times in total. Other errors, and the last
// transient one, are thrown unchanged. Only use it for work that is safe to
// repeat, such as a whole transaction that rolled back.
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  { attempts = DEFAULT_ATTEMPTS, wait = sleep }: TransientRetryOptions = {}
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientDatabaseError(error)) {
        throw error;
      }

      // A random delay keeps two conflicting requests from colliding again.
      await wait(
        MINIMUM_DELAY_MILLISECONDS + Math.random() * DELAY_SPREAD_MILLISECONDS
      );
    }
  }
}
