// Arabic letters, including the presentation forms that PDF fonts often use.
const ARABIC_LETTER =
  /[ء-يٮ-ۓۺ-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-ﻼ]/gu;
// Every character from the Arabic blocks, including punctuation and marks.
const ARABIC_CHARACTER =
  /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/gu;
const LETTER = /\p{L}/gu;

// Arabic text is not supported yet. Documents at or above this share of
// Arabic letters fail; smaller Arabic fragments are removed.
export const MAX_ARABIC_RATIO = 0.05;

export function arabicRatio(texts: string[]): number {
  const joined = texts.join(' ');
  const letters = joined.match(LETTER)?.length ?? 0;
  const arabicLetters = joined.match(ARABIC_LETTER)?.length ?? 0;
  return letters === 0 ? 0 : arabicLetters / letters;
}

export function hasTooMuchArabic(texts: string[]): boolean {
  return arabicRatio(texts) >= MAX_ARABIC_RATIO;
}

export function removeArabic(text: string): string {
  return text.replace(ARABIC_CHARACTER, '');
}
