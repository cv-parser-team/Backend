import { Readable } from 'node:stream';
import {
  CorruptedDocumentError,
  DocumentPurposeMismatchError,
  EmptyDocumentError,
  InvalidDocumentFilenameError,
  UnsupportedDocumentTypeError
} from './documents.errors.js';
import {
  allowedDocumentMediaTypes,
  documentMediaType
} from './documents.formats.js';
import type {
  DocumentMediaType,
  DocumentPurpose
} from './documents.formats.js';

interface DocumentFormat {
  mediaType: DocumentMediaType;
  signature: Buffer;
  structuralMarkers: readonly Buffer[];
  endMarker: Buffer;
}

const documentFormats = [
  {
    mediaType: documentMediaType.pdf,
    signature: Buffer.from('%PDF-'),
    structuralMarkers: [],
    endMarker: Buffer.from('%%EOF')
  },
  {
    mediaType: documentMediaType.docx,
    signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    structuralMarkers: [
      Buffer.from('[Content_Types].xml'),
      Buffer.from('word/document.xml')
    ],
    endMarker: Buffer.from([0x50, 0x4b, 0x05, 0x06])
  },
  {
    mediaType: documentMediaType.jpeg,
    signature: Buffer.from([0xff, 0xd8, 0xff]),
    structuralMarkers: [],
    endMarker: Buffer.from([0xff, 0xd9])
  },
  {
    mediaType: documentMediaType.png,
    signature: Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]),
    structuralMarkers: [Buffer.from('IHDR')],
    endMarker: Buffer.from([
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44
    ])
  }
] satisfies readonly DocumentFormat[];

const structuralMarkers = documentFormats.flatMap(
  (format) => format.structuralMarkers
);

const maximumSignatureLength = Math.max(
  ...documentFormats.map((format) => format.signature.byteLength)
);

const maximumMarkerLength = Math.max(
  ...structuralMarkers.map((marker) => marker.byteLength)
);
// ZIP end records may be followed by a comment of up to 65,535 bytes.
const tailByteLength = 65_557;

export interface ValidateDocumentInput {
  purpose: DocumentPurpose;
  originalFilename: string;
  byteSize: number;
  stream: Readable;
}

export interface ValidatedDocument {
  mediaType: DocumentMediaType;
}

export interface DocumentValidator {
  validate(input: ValidateDocumentInput): Promise<ValidatedDocument>;
}

interface StreamInspection {
  prefix: Buffer;
  tail: Buffer;
  byteSize: number;
  foundMarkers: ReadonlySet<Buffer>;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  throw new CorruptedDocumentError();
}

async function inspectStream(stream: Readable): Promise<StreamInspection> {
  let prefix = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let scanCarry = Buffer.alloc(0);
  let byteSize = 0;
  const foundMarkers = new Set<Buffer>();

  for await (const chunk of stream) {
    const bytes = toBuffer(chunk);
    byteSize += bytes.byteLength;

    if (prefix.byteLength < maximumSignatureLength) {
      const neededBytes = maximumSignatureLength - prefix.byteLength;
      prefix = Buffer.concat([prefix, bytes.subarray(0, neededBytes)]);
    }

    const scanWindow = Buffer.concat([scanCarry, bytes]);
    for (const marker of structuralMarkers) {
      if (scanWindow.includes(marker)) {
        foundMarkers.add(marker);
      }
    }
    scanCarry = scanWindow.subarray(
      Math.max(0, scanWindow.byteLength - maximumMarkerLength + 1)
    );

    tail = Buffer.concat([tail, bytes]).subarray(-tailByteLength);
  }

  return { prefix, tail, byteSize, foundMarkers };
}

function detectMediaType(prefix: Buffer): DocumentMediaType {
  for (const format of documentFormats) {
    if (
      prefix.subarray(0, format.signature.byteLength).equals(format.signature)
    ) {
      return format.mediaType;
    }
  }

  throw new UnsupportedDocumentTypeError();
}

function assertStructurallyValid(
  mediaType: DocumentMediaType,
  inspection: StreamInspection
): void {
  const format = documentFormats.find(
    (candidate) => candidate.mediaType === mediaType
  );
  const valid =
    format !== undefined &&
    format.structuralMarkers.every((marker) =>
      inspection.foundMarkers.has(marker)
    ) &&
    inspection.tail.includes(format.endMarker);

  if (!valid) {
    throw new CorruptedDocumentError();
  }
}

export function createDocumentValidator(): DocumentValidator {
  return {
    async validate(input) {
      if (
        input.originalFilename.trim().length === 0 ||
        [...input.originalFilename].length > 255
      ) {
        throw new InvalidDocumentFilenameError();
      }

      if (input.byteSize <= 0) {
        throw new EmptyDocumentError();
      }

      const inspection = await inspectStream(input.stream);
      if (inspection.byteSize !== input.byteSize) {
        throw new CorruptedDocumentError();
      }

      const mediaType = detectMediaType(inspection.prefix);
      if (!allowedDocumentMediaTypes[input.purpose].includes(mediaType)) {
        throw new DocumentPurposeMismatchError();
      }

      assertStructurallyValid(mediaType, inspection);
      return { mediaType };
    }
  };
}
