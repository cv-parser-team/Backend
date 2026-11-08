import { describe, expect, it } from 'vitest';
import { selectInspectionInputNames } from './inspect-all-parsing.js';

describe('selectInspectionInputNames', () => {
  it('selects supported documents in deterministic order', () => {
    expect(
      selectInspectionInputNames([
        'resume.pdf.parsing.html',
        'notes.txt',
        'z.docx',
        'A.PDF',
        'middle.pdf'
      ])
    ).toEqual(['A.PDF', 'middle.pdf', 'z.docx']);
  });
});
