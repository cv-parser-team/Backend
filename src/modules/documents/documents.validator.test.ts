import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CorruptedDocumentError,
  DocumentPurposeMismatchError,
  EmptyDocumentError,
  InvalidDocumentFilenameError,
  UnsupportedDocumentTypeError
} from './documents.errors.js';
import type { DocumentMediaType } from './documents.formats.js';
import { createDocumentValidator } from './documents.validator.js';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR'),
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44])
]);
const docx = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('[Content_Types].xml'),
  Buffer.from('word/document.xml'),
  Buffer.from([0x50, 0x4b, 0x05, 0x06])
]);

describe('document validator', () => {
  const validator = createDocumentValidator();

  it.each<[string, Buffer, DocumentMediaType]>([
    ['PDF', pdf, 'application/pdf'],
    [
      'DOCX',
      docx,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
  ])('accepts a structurally valid %s source', async (_name, contents, mediaType) => {
    await expect(
      validator.validate({
        purpose: 'source',
        originalFilename: 'resume',
        byteSize: contents.byteLength,
        stream: Readable.from(contents)
      })
    ).resolves.toEqual({ mediaType });
  });

  it.each<[string, Buffer, DocumentMediaType]>([
    ['JPEG', jpeg, 'image/jpeg'],
    ['PNG', png, 'image/png']
  ])('accepts a structurally valid %s evidence file', async (_name, contents, mediaType) => {
    await expect(
      validator.validate({
        purpose: 'evidence',
        originalFilename: 'evidence',
        byteSize: contents.byteLength,
        stream: Readable.from(contents)
      })
    ).resolves.toEqual({ mediaType });
  });

  it('finds structural markers split across stream chunks', async () => {
    const chunks = [...docx].map((byte) => Buffer.from([byte]));

    await expect(
      validator.validate({
        purpose: 'source',
        originalFilename: 'resume.docx',
        byteSize: docx.byteLength,
        stream: Readable.from(chunks)
      })
    ).resolves.toEqual({
      mediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  });

  it.each(['   ', '😀'.repeat(256)])(
    'rejects invalid filename %j',
    async (originalFilename) => {
      await expect(
        validator.validate({
          purpose: 'source',
          originalFilename,
          byteSize: pdf.byteLength,
          stream: Readable.from(pdf)
        })
      ).rejects.toBeInstanceOf(InvalidDocumentFilenameError);
    }
  );

  it('rejects empty documents', async () => {
    await expect(
      validator.validate({
        purpose: 'source',
        originalFilename: 'resume.pdf',
        byteSize: 0,
        stream: Readable.from([])
      })
    ).rejects.toBeInstanceOf(EmptyDocumentError);
  });

  it('rejects unsupported content', async () => {
    const contents = Buffer.from('plain text');

    await expect(
      validator.validate({
        purpose: 'source',
        originalFilename: 'resume.pdf',
        byteSize: contents.byteLength,
        stream: Readable.from(contents)
      })
    ).rejects.toBeInstanceOf(UnsupportedDocumentTypeError);
  });

  it('rejects an image used as a source document', async () => {
    await expect(
      validator.validate({
        purpose: 'source',
        originalFilename: 'resume.jpg',
        byteSize: jpeg.byteLength,
        stream: Readable.from(jpeg)
      })
    ).rejects.toBeInstanceOf(DocumentPurposeMismatchError);
  });

  it('rejects content missing its structural end marker', async () => {
    const truncatedPdf = Buffer.from('%PDF-1.7\ntruncated');

    await expect(
      validator.validate({
        purpose: 'source',
        originalFilename: 'resume.pdf',
        byteSize: truncatedPdf.byteLength,
        stream: Readable.from(truncatedPdf)
      })
    ).rejects.toBeInstanceOf(CorruptedDocumentError);
  });

  it('rejects a staged byte count that does not match the stream', async () => {
    await expect(
      validator.validate({
        purpose: 'source',
        originalFilename: 'resume.pdf',
        byteSize: pdf.byteLength + 1,
        stream: Readable.from(pdf)
      })
    ).rejects.toBeInstanceOf(CorruptedDocumentError);
  });
});
