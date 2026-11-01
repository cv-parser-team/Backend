import { UnsupportedDocumentTypeError } from './parsing.errors.js';
import { ExtractionRecord, ParsingRepository } from './parsing.repository.js';
import { DocumentParser, ParseInput } from './parsing.types.js';

export interface ExtractInput extends ParseInput {
  documentId: string;
}

export interface ParsingService {
  extract(input: ExtractInput): Promise<ExtractionRecord>;
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
    async extract(input) {
      const parser = parsersByMediaType.get(input.mediaType);
      if (!parser) {
        throw new UnsupportedDocumentTypeError(input.mediaType);
      }

      const result = await parser.parse(input.content);
      return repository.saveExtraction(input.documentId, result);
    }
  };
}
