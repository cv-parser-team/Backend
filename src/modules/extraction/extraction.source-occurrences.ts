import {
  resolveSourceReferences,
  type ExtractionResult,
  type PhysicalSourceAnchor
} from '../parsing/index.js';
import { SourceReferenceResolutionError } from './extraction.errors.js';
import type { ClaimDraft } from './extraction.mapper.js';

export interface ClaimSourceOccurrenceDraft {
  anchorKey: string;
  references: string[];
  fields: string[];
  anchor: PhysicalSourceAnchor;
}

function anchorKey(anchor: PhysicalSourceAnchor): string {
  switch (anchor.kind) {
    case 'pdf_line':
      return `pdf:${anchor.pageNumber}:${anchor.order}`;
    case 'docx_paragraph':
      return `docx:${anchor.blockIndex}`;
    case 'docx_table_row':
      return `docx:${anchor.blockIndex}:${anchor.rowNumber}`;
  }
}

function appendUnique(values: string[], additions: Iterable<string>): void {
  const existing = new Set(values);
  for (const addition of additions) {
    if (!existing.has(addition)) {
      existing.add(addition);
      values.push(addition);
    }
  }
}

// Converts a claim's citations to persistence-ready physical evidence. This
// deliberately carries no inferred section, heading, or semantic-support flag.
export function mapClaimSourceOccurrences(
  claim: Pick<ClaimDraft, 'fieldSources'>,
  content: Pick<ExtractionResult, 'pages' | 'blocks'>
): ClaimSourceOccurrenceDraft[] {
  const fieldsByReference = new Map<string, string[]>();
  for (const [field, references] of Object.entries(claim.fieldSources)) {
    for (const reference of references) {
      const fields = fieldsByReference.get(reference) ?? [];
      appendUnique(fields, [field]);
      fieldsByReference.set(reference, fields);
    }
  }

  const resolution = resolveSourceReferences(
    content,
    [...fieldsByReference.keys()]
  );
  if (resolution.missing.length > 0 || resolution.ambiguous.length > 0) {
    throw new SourceReferenceResolutionError(
      resolution.missing,
      resolution.ambiguous
    );
  }

  const drafts = new Map<string, ClaimSourceOccurrenceDraft>();
  for (const resolved of resolution.resolved) {
    const fields = fieldsByReference.get(resolved.reference) ?? [];
    for (const anchor of resolved.anchors) {
      const key = anchorKey(anchor);
      const existing = drafts.get(key);
      if (existing) {
        appendUnique(existing.references, [resolved.reference]);
        appendUnique(existing.fields, fields);
      } else {
        drafts.set(key, {
          anchorKey: key,
          references: [resolved.reference],
          fields: [...fields],
          anchor
        });
      }
    }
  }

  return [...drafts.values()];
}
