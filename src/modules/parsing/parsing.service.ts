import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import { UnsupportedDocumentTypeError } from './parsing.errors.js';
import { ExtractionRecord, ParsingRepository } from './parsing.repository.js';
import type { UnmappedItem } from './parsing.table.js';
import { DocumentParser, ExtractionResult, ParseInput } from './parsing.types.js';

export interface ParsingService {
  // Reads the content without saving anything, so the caller decides when the
  // result is saved.
  parse(input: ParseInput): Promise<ExtractionResult>;
  // Replaces the document's extraction; inside the given transaction, if any.
  saveExtraction(
    documentId: string,
    result: ExtractionResult,
    transaction?: DatabaseExecutor
  ): Promise<ExtractionRecord>;
  // Replaces the latest AI-output snapshot of items that could not become
  // profile fields or claims. An empty list clears the previous snapshot.
  saveUnmappedData(
    documentId: string,
    items: UnmappedItem[],
    transaction?: DatabaseExecutor
  ): Promise<ExtractionRecord>;
}

export interface ParsingServiceDependencies {
  parsers: DocumentParser[];
  repository: ParsingRepository;
}

export function createParsingService({
  parsers,
  repository
}: ParsingServiceDependencies): ParsingService {
  // Each parser declares the media types it reads, so adding a format only
  // means adding a parser to this list.
  const parsersByMediaType = new Map(
    parsers.flatMap((parser) =>
      parser.mediaTypes.map((mediaType) => [mediaType, parser] as const)
    )
  );

  return {
    async parse(input) {
      const parser = parsersByMediaType.get(input.mediaType);
      if (!parser) {
        throw new UnsupportedDocumentTypeError(input.mediaType);
      }

      return parser.parse(input.content);
    },

    saveExtraction(documentId, result, transaction) {
      return repository.saveExtraction(documentId, result, transaction);
    },

    saveUnmappedData(documentId, items, transaction) {
      return repository.saveUnmappedData(documentId, items, transaction);
    }
  };
}
