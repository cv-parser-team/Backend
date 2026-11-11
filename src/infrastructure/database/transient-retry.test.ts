import { describe, expect, it, vi } from 'vitest';
import {
  TransientDatabaseError,
  UniqueConstraintViolationError
} from './database.errors.js';
import { withTransientRetry } from './transient-retry.js';

const noWait = () => Promise.resolve();

describe('transient retry', () => {
  it('returns the first result without retrying', async () => {
    const operation = vi.fn().mockResolvedValue('saved');

    await expect(withTransientRetry(operation, { wait: noWait })).resolves.toBe('saved');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('runs the operation again after a transient error', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new TransientDatabaseError())
      .mockResolvedValueOnce('saved');
    const wait = vi.fn(noWait);

    await expect(withTransientRetry(operation, { wait })).resolves.toBe('saved');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('waits a short random delay between attempts', async () => {
    const wait = vi.fn((_milliseconds: number) => noWait());
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new TransientDatabaseError())
      .mockResolvedValueOnce('saved');

    await withTransientRetry(operation, { wait });

    const delay = wait.mock.calls[0]?.[0] ?? -1;
    expect(delay).toBeGreaterThanOrEqual(20);
    expect(delay).toBeLessThanOrEqual(100);
  });

  it('retries a raw driver deadlock raised while committing', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ code: '40P01', message: 'deadlock detected' })
      .mockResolvedValueOnce('saved');

    await expect(withTransientRetry(operation, { wait: noWait })).resolves.toBe('saved');
  });

  it('stops after three attempts and throws the last error', async () => {
    const lastError = new TransientDatabaseError('still busy');
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new TransientDatabaseError())
      .mockRejectedValueOnce(new TransientDatabaseError())
      .mockRejectedValueOnce(lastError);

    await expect(withTransientRetry(operation, { wait: noWait })).rejects.toBe(lastError);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it.each([
    new UniqueConstraintViolationError('duplicate'),
    new Error('could not transition to ready')
  ])('throws other errors at once: %o', async (error) => {
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withTransientRetry(operation, { wait: noWait })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });
});
