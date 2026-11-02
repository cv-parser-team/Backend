import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform, TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
    DocumentTooLargeError,
    InvalidStorageKeyError
} from './documents.errors.js';

const storageKeyPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertValidStorageKey(key: string): void {
    if (!storageKeyPattern.test(key)) {
        throw new InvalidStorageKeyError();
    }
}

function isMissingFileError(error: unknown): boolean {
    return (
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
    );
}

export interface StagedDocument {
    stagingKey: string;
    byteSize: number;
    sha256: string;
}

export interface StoredDocumentObject {
    storageKey: string;
    modifiedAt: Date;
}

export interface DocumentStorage {
    stage(stream: Readable): Promise<StagedDocument>;
    openStaged(stagingKey: string): Promise<Readable>;
    commit(stagingKey: string): Promise<string>;
    discard(stagingKey: string): Promise<void>;
    cleanupStaged(olderThan: Date): Promise<number>;
    listStoredObjects(olderThan: Date): Promise<StoredDocumentObject[]>;
    open(storageKey: string): Promise<Readable>;
    delete(storageKey: string): Promise<void>;
}

export interface LocalDocumentStorageOptions {
    storageRoot: string;
    maximumByteSize: number;
}

export function createLocalDocumentStorage(
    options: LocalDocumentStorageOptions
): DocumentStorage {
    const { storageRoot, maximumByteSize } = options;
    const stagingDirectory = join(storageRoot, 'staging');
    const objectsDirectory = join(storageRoot, 'objects');
    return {
        async stage(stream) {
            await mkdir(stagingDirectory, { recursive: true });
            const stagingKey = randomUUID();
            const stagingPath = join(stagingDirectory, stagingKey);
            const hash = createHash('sha256');
            let byteSize = 0;
            const metadataTransform = new Transform({
                transform(
                    chunk: Buffer | string,
                    encoding: BufferEncoding,
                    callback: TransformCallback
                ) {
                    const bytes = Buffer.isBuffer(chunk)
                        ? chunk
                        : Buffer.from(chunk, encoding);
                    byteSize += bytes.byteLength;

                    if (byteSize > maximumByteSize) {
                        callback(new DocumentTooLargeError(maximumByteSize));
                        return;
                    }

                    hash.update(bytes);
                    callback(null, bytes);
                }
            });

            try {
                await pipeline(
                    stream,
                    metadataTransform,
                    createWriteStream(stagingPath, { flags: 'wx' })
                );
            } catch (error) {
                await rm(stagingPath, { force: true });
                throw error;
            }

            return {
                stagingKey,
                byteSize,
                sha256: hash.digest('hex')
            };
        },
        async openStaged(stagingKey) {
            assertValidStorageKey(stagingKey);
            return createReadStream(join(stagingDirectory, stagingKey));
        },
        async commit(stagingKey) {
            assertValidStorageKey(stagingKey);

            await mkdir(objectsDirectory, { recursive: true });
            const storageKey = randomUUID();

            const stagingPath = join(stagingDirectory, stagingKey);
            const storagePath = join(objectsDirectory, storageKey);
            await rename(stagingPath, storagePath);

            return storageKey;
        },
        async discard(stagingKey) {
            assertValidStorageKey(stagingKey);
            await rm(join(stagingDirectory, stagingKey), { force: true });
        },
        async cleanupStaged(olderThan) {
            await mkdir(stagingDirectory, { recursive: true });
            const entries = await readdir(stagingDirectory, {
                withFileTypes: true
            });
            let deleted = 0;

            for (const entry of entries) {
                if (!entry.isFile() || !storageKeyPattern.test(entry.name)) {
                    continue;
                }

                const stagingPath = join(stagingDirectory, entry.name);

                try {
                    const metadata = await stat(stagingPath);

                    if (metadata.mtime >= olderThan) {
                        continue;
                    }

                    await rm(stagingPath, { force: true });
                    deleted += 1;
                } catch (error) {
                    if (isMissingFileError(error)) {
                        continue;
                    }

                    throw error;
                }
            }

            return deleted;
        },
        async listStoredObjects(olderThan) {
            await mkdir(objectsDirectory, { recursive: true });
            const entries = await readdir(objectsDirectory, {
                withFileTypes: true
            });
            const objects: StoredDocumentObject[] = [];

            for (const entry of entries) {
                if (!entry.isFile() || !storageKeyPattern.test(entry.name)) {
                    continue;
                }

                try {
                    const metadata = await stat(
                        join(objectsDirectory, entry.name)
                    );

                    if (metadata.mtime < olderThan) {
                        objects.push({
                            storageKey: entry.name,
                            modifiedAt: metadata.mtime
                        });
                    }
                } catch (error) {
                    if (isMissingFileError(error)) {
                        continue;
                    }

                    throw error;
                }
            }

            return objects;
        },
        async open(storageKey) {
            assertValidStorageKey(storageKey);
            return createReadStream(join(objectsDirectory, storageKey));
        },
        async delete(storageKey) {
            assertValidStorageKey(storageKey);
            await rm(join(objectsDirectory, storageKey), { force: true });
        }
    };
}
