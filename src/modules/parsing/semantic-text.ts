const SPACED_GLYPH_RUN = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}]\s+){1,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu;

// PDF generators frequently draw headings and dates one glyph at a time.
// Keep the extracted text unchanged, but remove that drawing-space noise from
// the semantic view used by classifiers.
export function normalizeSemanticText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(SPACED_GLYPH_RUN, (run) => run.replace(/\s+/gu, ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

export function normalizeSectionKey(text: string): string {
  return normalizeSemanticText(text)
    .replace(/\s*[&/]\s*/gu, ' and ')
    .replace(/[.:|]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}
