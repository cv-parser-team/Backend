import type { AppDatabase } from './database.js';

// The query methods shared by the database and a transaction. Repository
// methods that must join a caller's transaction accept one of these.
export type DatabaseExecutor = Pick<
  AppDatabase['db'],
  'select' | 'insert' | 'update' | 'delete'
>;

// Runs several writes, possibly owned by different modules, as one
// transaction: they are all saved, or none is if the work throws.
export interface UnitOfWork {
  run<T>(work: (transaction: DatabaseExecutor) => Promise<T>): Promise<T>;
}

export function createUnitOfWork(database: AppDatabase): UnitOfWork {
  return {
    run(work) {
      return database.db.transaction((transaction) => work(transaction));
    }
  };
}
