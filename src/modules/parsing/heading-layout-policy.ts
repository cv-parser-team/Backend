import type { HeadingRole } from './heading-classifier.js';

export type HeadingLayoutAction =
  | 'none'
  | 'header-boundary'
  | 'section-boundary'
  | 'entry-boundary';

export interface HeadingClassification {
  role: HeadingRole;
  confidence: number;
}

export const HEADING_AUTHORITY_SETTINGS = {
  documentTitle: 0.75,
  documentSubtitle: 0.7,
  sectionHeading: 0.8,
  entryHeading: 0.7
} as const;

export function headingLayoutAction({
  role,
  confidence
}: HeadingClassification): HeadingLayoutAction {
  switch (role) {
    case 'document-title':
      return confidence >= HEADING_AUTHORITY_SETTINGS.documentTitle
        ? 'header-boundary'
        : 'none';
    case 'document-subtitle':
      return confidence >= HEADING_AUTHORITY_SETTINGS.documentSubtitle
        ? 'header-boundary'
        : 'none';
    case 'section-heading':
      return confidence >= HEADING_AUTHORITY_SETTINGS.sectionHeading
        ? 'section-boundary'
        : 'none';
    case 'entry-heading':
      return confidence >= HEADING_AUTHORITY_SETTINGS.entryHeading
        ? 'entry-boundary'
        : 'none';
    case 'heading-candidate':
    case 'body':
      return 'none';
  }
}
