import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import {
  DocumentTooLargeError,
  InvalidStorageKeyError
} from './documents.errors.js';
import {
  assertValidStorageKey,
  createLocalDocumentStorage
} from './documents.storage.js';

describe('document storage keys', () => {
  it('accepts opaque UUID v4 keys', () => {
    expect(() =>
      assertValidStorageKey('550e8400-e29b-41d4-a716-446655440000')
    ).not.toThrow();
  });

  it.each([
    '../../secret',
    'objects/550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-11d4-a716-446655440000',
    '',
    'resume.pdf'
  ])('rejects invalid or path-like key %j', (key) => {
    expect(() => assertValidStorageKey(key)).toThrow(InvalidStorageKeyError);
  });
});

describe('local document storage staging', () => {
  it('streams the document to staging and returns its metadata', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: Number.MAX_SAFE_INTEGER
    });
    const contents = Buffer.from('candidate document contents');

    try {
      const staged = await storage.stage(Readable.from(contents));

      expect(() => assertValidStorageKey(staged.stagingKey)).not.toThrow();
      expect(staged.byteSize).toBe(contents.byteLength);
      expect(staged.sha256).toBe(
        createHash('sha256').update(contents).digest('hex')
      );
      await expect(
        readFile(join(storageRoot, 'staging', staged.stagingKey))
      ).resolves.toEqual(contents);
      await expect(
        buffer(await storage.openStaged(staged.stagingKey))
      ).resolves.toEqual(contents);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('removes a partial staged file when the input stream fails', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: Number.MAX_SAFE_INTEGER
    });
    const stream = new Readable({
      read() {
        this.push('partial contents');
        this.destroy(new Error('upload failed'));
      }
    });

    try {
      await expect(storage.stage(stream)).rejects.toThrow('upload failed');
      await expect(readdir(join(storageRoot, 'staging'))).resolves.toEqual([]);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('accepts a document exactly at the size limit', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: 5
    });

    try {
      const staged = await storage.stage(Readable.from('12345'));

      expect(staged.byteSize).toBe(5);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('rejects oversized documents and removes the partial file', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: 5
    });

    try {
      await expect(storage.stage(Readable.from('123456'))).rejects.toThrow(
        DocumentTooLargeError
      );
      await expect(readdir(join(storageRoot, 'staging'))).resolves.toEqual([]);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('reports a read error for a missing staged document', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: 1024
    });

    try {
      const stream = await storage.openStaged(
        '550e8400-e29b-41d4-a716-446655440000'
      );

      await expect(buffer(stream)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid staged storage keys', async () => {
    const storage = createLocalDocumentStorage({
      storageRoot: '/private/storage',
      maximumByteSize: 1024
    });

    await expect(storage.openStaged('../../secret')).rejects.toThrow(
      InvalidStorageKeyError
    );
    await expect(storage.discard('../../secret')).rejects.toThrow(
      InvalidStorageKeyError
    );
  });

  it('discards staged documents idempotently', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: Number.MAX_SAFE_INTEGER
    });

    try {
      const staged = await storage.stage(Readable.from('temporary document'));

      await storage.discard(staged.stagingKey);
      await expect(storage.discard(staged.stagingKey)).resolves.toBeUndefined();
      await expect(
        readFile(join(storageRoot, 'staging', staged.stagingKey))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});

describe('local committed document storage', () => {
  it('opens a committed document without changing its contents', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: Number.MAX_SAFE_INTEGER
    });
    const contents = Buffer.from('committed candidate document');

    try {
      const staged = await storage.stage(Readable.from(contents));
      const storageKey = await storage.commit(staged.stagingKey);

      expect(() => assertValidStorageKey(storageKey)).not.toThrow();
      await expect(buffer(await storage.open(storageKey))).resolves.toEqual(
        contents
      );
      await expect(
        readFile(join(storageRoot, 'staging', staged.stagingKey))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('keeps the staged file when commit fails', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: Number.MAX_SAFE_INTEGER
    });

    try {
      const staged = await storage.stage(Readable.from('staged document'));
      await writeFile(join(storageRoot, 'objects'), 'not a directory');

      await expect(storage.commit(staged.stagingKey)).rejects.toThrow();
      await expect(
        readFile(join(storageRoot, 'staging', staged.stagingKey), 'utf8')
      ).resolves.toBe('staged document');
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('reports a read error for a missing committed document', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: 1024
    });

    try {
      const stream = await storage.open(
        '550e8400-e29b-41d4-a716-446655440000'
      );

      await expect(buffer(stream)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid permanent storage keys', async () => {
    const storage = createLocalDocumentStorage({
      storageRoot: '/private/storage',
      maximumByteSize: 1024
    });

    await expect(storage.open('../../secret')).rejects.toThrow(
      InvalidStorageKeyError
    );
    await expect(storage.delete('../../secret')).rejects.toThrow(
      InvalidStorageKeyError
    );
  });

  it('deletes committed documents idempotently', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'luminacv-storage-'));
    const storage = createLocalDocumentStorage({
      storageRoot,
      maximumByteSize: Number.MAX_SAFE_INTEGER
    });

    try {
      const staged = await storage.stage(Readable.from('permanent document'));
      const storageKey = await storage.commit(staged.stagingKey);

      await storage.delete(storageKey);
      await expect(storage.delete(storageKey)).resolves.toBeUndefined();
      await expect(
        readFile(join(storageRoot, 'objects', storageKey))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
