import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './database.js';
import { createUnitOfWork, type DatabaseExecutor } from './unit-of-work.js';

function createDatabase(transaction: DatabaseExecutor) {
  const runTransaction = vi.fn(
    (work: (transaction: DatabaseExecutor) => Promise<unknown>) => work(transaction)
  );

  return {
    database: { db: { transaction: runTransaction } } as unknown as AppDatabase,
    runTransaction
  };
}

describe('unit of work', () => {
  const transaction = {} as DatabaseExecutor;

  it('runs the work in one transaction and returns its result', async () => {
    const { database, runTransaction } = createDatabase(transaction);
    const work = vi.fn().mockResolvedValue('saved');

    await expect(createUnitOfWork(database).run(work)).resolves.toBe('saved');

    expect(runTransaction).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledWith(transaction);
  });

  it('runs the whole transaction again after a deadlock', async () => {
    const { database, runTransaction } = createDatabase(transaction);
    runTransaction.mockRejectedValueOnce({ code: '40P01', message: 'deadlock detected' });
    const work = vi.fn().mockResolvedValue('saved');

    await expect(
      createUnitOfWork(database, { wait: () => Promise.resolve() }).run(work)
    ).resolves.toBe('saved');

    expect(runTransaction).toHaveBeenCalledTimes(2);
  });

  it('passes the work error on unchanged, so the transaction rolls back', async () => {
    const { database } = createDatabase(transaction);
    const failure = new Error('document could not transition');

    await expect(
      createUnitOfWork(database).run(() => Promise.reject(failure))
    ).rejects.toBe(failure);
  });
});
