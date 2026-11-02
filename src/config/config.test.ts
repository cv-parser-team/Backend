import { isAbsolute } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  config,
  extractPositiveIntegerOrDefault,
  extractPositiveIntegerOrThrow,
  extractPrivateDirectoryOrThrow
} from './config.js';

describe('document storage configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes an absolute private storage root and positive upload limits', () => {
    expect(isAbsolute(config.documents.storageRoot)).toBe(true);
    expect(config.documents.maximumUploadFiles).toBe(5);
    expect(config.documents.maximumUploadByteSize).toBe(10_485_760);
    expect(config.documents.stagingMaximumAgeSeconds).toBe(86_400);
    expect(config.documents.orphanGracePeriodSeconds).toBe(86_400);
  });

  it('uses a default when an optional positive integer is absent', () => {
    vi.stubEnv('TEST_OPTIONAL_POSITIVE_INTEGER', undefined);

    expect(
      extractPositiveIntegerOrDefault('TEST_OPTIONAL_POSITIVE_INTEGER', 60)
    ).toBe(60);
  });

  it.each(['0', '-1', '1.5', 'invalid'])(
    'rejects invalid positive integer value %j',
    (value) => {
      vi.stubEnv('TEST_POSITIVE_INTEGER', value);

      expect(() =>
        extractPositiveIntegerOrThrow('TEST_POSITIVE_INTEGER')
      ).toThrow('TEST_POSITIVE_INTEGER must be a positive integer');
    }
  );

  it('rejects a filesystem root as a private directory', () => {
    vi.stubEnv('TEST_PRIVATE_DIRECTORY', '/');

    expect(() =>
      extractPrivateDirectoryOrThrow('TEST_PRIVATE_DIRECTORY')
    ).toThrow('TEST_PRIVATE_DIRECTORY must not be a filesystem root');
  });
});
