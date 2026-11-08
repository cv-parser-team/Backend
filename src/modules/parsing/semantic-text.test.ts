import { describe, expect, it } from 'vitest';
import { normalizeSectionKey, normalizeSemanticText } from './semantic-text.js';

describe('semantic text normalization', () => {
  it('removes drawing spaces from letters and digits without changing ordinary words', () => {
    expect(normalizeSemanticText('E D U C A T I O N & C E R T I F I C A T I O N S'))
      .toBe('EDUCATION & CERTIFICATIONS');
    expect(normalizeSemanticText('2 0 2 0 – 2 0 2 3')).toBe('2020 – 2023');
    expect(normalizeSemanticText('Senior Product Manager')).toBe('Senior Product Manager');
  });

  it('normalizes equivalent section separators', () => {
    expect(normalizeSectionKey('AWARDS/ CERTIFICATION:')).toBe(
      'awards and certification'
    );
  });
});
