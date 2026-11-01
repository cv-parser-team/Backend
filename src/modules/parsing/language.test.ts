import { describe, expect, it } from 'vitest';
import { arabicRatio, hasTooMuchArabic, MAX_ARABIC_RATIO, removeArabic } from './language.js';

describe('language rules', () => {
  it('measures the share of Arabic letters among all letters', () => {
    expect(arabicRatio(['abcd', 'مرشح'])).toBe(0.5);
    expect(arabicRatio(['Python 3.12, 2021-03'])).toBe(0);
    expect(arabicRatio(['', '  ', '2024'])).toBe(0);
  });

  it('counts Arabic presentation forms used by PDF fonts', () => {
    expect(arabicRatio(['ﺪﻤﺤﻣ'])).toBe(1);
  });

  it(`rejects text with ${MAX_ARABIC_RATIO * 100}% Arabic letters or more`, () => {
    expect(hasTooMuchArabic(['a'.repeat(95) + 'م'.repeat(5)])).toBe(true);
    expect(hasTooMuchArabic(['a'.repeat(96) + 'م'.repeat(4)])).toBe(false);
  });

  it('removes Arabic letters, presentation forms, and punctuation', () => {
    expect(removeArabic('Laravel وPHP، MySQL')).toBe('Laravel PHP MySQL');
    expect(removeArabic('ﺪﻤﺤﻣ Sample')).toBe(' Sample');
  });
});
