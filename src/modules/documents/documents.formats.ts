export const documentMediaType = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpeg: 'image/jpeg',
  png: 'image/png'
} as const;

export type DocumentMediaType =
  (typeof documentMediaType)[keyof typeof documentMediaType];

export const documentMediaTypes: readonly DocumentMediaType[] =
  Object.values(documentMediaType);

export const documentPurposes = ['source', 'evidence'] as const;

export type DocumentPurpose = (typeof documentPurposes)[number];

export const allowedDocumentMediaTypes: Readonly<
  Record<DocumentPurpose, readonly DocumentMediaType[]>
> = {
  source: [documentMediaType.pdf, documentMediaType.docx],
  evidence: documentMediaTypes
};
