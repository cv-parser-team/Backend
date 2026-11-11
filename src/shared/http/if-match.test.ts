import { describe, expect, it } from 'vitest';
import { InvalidIfMatchError, parseIfMatchVersion, versionEtag } from './if-match.js';

describe('If-Match versions', () => {
  it('treats a missing header as an unchecked write', () => {
    expect(parseIfMatchVersion(undefined)).toBeUndefined();
  });

  it.each([
    ['3', 3],
    ['"3"', 3],
    ['W/"3"', 3],
    [' "12" ', 12]
  ])('reads %s as version %i', (header, version) => {
    expect(parseIfMatchVersion(header)).toBe(version);
  });

  it.each(['', '*', '"abc"', '0', '-1', '1.5', '"3", "4"', '12345678901'])(
    'rejects %s',
    (header) => {
      expect(() => parseIfMatchVersion(header)).toThrow(InvalidIfMatchError);
    }
  );

  it('rejects a repeated header', () => {
    expect(() => parseIfMatchVersion(['"3"', '"4"'])).toThrow(InvalidIfMatchError);
  });

  it('writes the version as a strong entity tag', () => {
    expect(versionEtag(7)).toBe('"7"');
  });
});
