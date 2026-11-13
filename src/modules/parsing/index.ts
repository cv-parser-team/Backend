import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { createDocxParser } from './docx-parser.js';
import { createParsingRepository } from './parsing.repository.js';
import { createParsingService, ParsingService } from './parsing.service.js';
import { createPdfParser } from './pdf-parser.js';

declare module 'fastify' {
  interface FastifyInstance {
    parsingService: ParsingService;
  }
}

const registerParsing: FastifyPluginAsync = async (fastify) => {
  const repository = createParsingRepository(fastify.database);
  const service = createParsingService({
    parsers: [createPdfParser(), createDocxParser()],
    repository
  });

  fastify.decorate('parsingService', service);
};

export const parsingModule = fastifyPlugin(registerParsing, {
  name: 'parsing',
  dependencies: ['database']
});

export { buildAiInput } from './ai-input.js';
export type { ParsingService } from './parsing.service.js';
