import type { AppDatabase } from './database.js';
import { type TransientRetryOptions, withTransientRetry } from './transient-retry.js';

// The query methods shared by the database and a transaction. Repository
// methods that must join a caller's transaction accept one of these.
export type DatabaseExecutor = Pick<
  AppDatabase['db'],
  'select' | 'insert' | 'update' | 'delete'
>;

// Runs several writes, possibly owned by different modules, as one
// transaction: they are all saved, or none is if the work throws. A transaction
// that fails with a transient error, such as a deadlock, rolls back and runs
// again, so the work must only write through the transaction it receives.
export interface UnitOfWork {
  run<T>(work: (transaction: DatabaseExecutor) => Promise<T>): Promise<T>;
}

export function createUnitOfWork(
  database: AppDatabase,
  retry: TransientRetryOptions = {}
): UnitOfWork {
  return {
    run(work) {
      return withTransientRetry(
        () => database.db.transaction((transaction) => work(transaction)),
        retry
      );
    }
  };
}
