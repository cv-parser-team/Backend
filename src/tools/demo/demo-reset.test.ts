import { describe, expect, it, vi } from 'vitest';
import { assertDemoAllowed, type DemoStore, resetDemoData } from './demo-reset.js';

function setup(userIds: string[], storageKeys: string[]) {
  const operations: string[] = [];
  const store: DemoStore = {
    findDemoUserIds: vi.fn(async () => userIds),
    findDocumentStorageKeys: vi.fn(async () => storageKeys),
    deleteUsers: vi.fn(async () => {
      operations.push('delete users');
    }),
    createUser: vi.fn()
  };
  const storage = {
    delete: vi.fn(async (storageKey: string) => {
      operations.push(`delete file ${storageKey}`);
    })
  };
  return { store, storage, operations };
}

describe('demo reset', () => {
  it('deletes demo files, then demo users', async () => {
    const { store, storage, operations } = setup(['u-1', 'u-2'], ['k-1']);

    await expect(resetDemoData({ store, storage, nodeEnv: 'development' })).resolves.toEqual({
      users: 2,
      files: 1
    });

    expect(store.findDocumentStorageKeys).toHaveBeenCalledWith(['u-1', 'u-2']);
    expect(store.deleteUsers).toHaveBeenCalledWith(['u-1', 'u-2']);
    expect(operations).toEqual(['delete file k-1', 'delete users']);
  });

  it('keeps the users when a file cannot be deleted, so a later reset finds them again', async () => {
    const { store, storage } = setup(['u-1'], ['k-1']);
    storage.delete.mockRejectedValue(new Error('disk unavailable'));

    await expect(resetDemoData({ store, storage, nodeEnv: 'development' })).rejects.toThrow(
      'disk unavailable'
    );
    expect(store.deleteUsers).not.toHaveBeenCalled();
  });

  it('does nothing when there is no demo data', async () => {
    const { store, storage } = setup([], []);

    await expect(resetDemoData({ store, storage, nodeEnv: 'test' })).resolves.toEqual({
      users: 0,
      files: 0
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('refuses to run in production', async () => {
    const { store, storage } = setup(['u-1'], []);

    await expect(resetDemoData({ store, storage, nodeEnv: 'production' })).rejects.toThrow(
      'Demo data cannot be used in production'
    );
    expect(store.findDemoUserIds).not.toHaveBeenCalled();
  });

  it.each(['development', 'test'])('allows the %s environment', (nodeEnv) => {
    expect(() => assertDemoAllowed(nodeEnv)).not.toThrow();
  });
});
