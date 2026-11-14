import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildParsingInspectionReport } from '../modules/parsing/inspection-report.js';
import { buildAiInput } from '../modules/parsing/ai-input.js';
import type { LayoutTrace } from '../modules/parsing/layout.js';
import type { DocumentParser } from '../modules/parsing/parsing.types.js';

function cleanPastedPath(value: string): string {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

async function selectInputPath(argument: string | undefined): Promise<string> {
  if (argument) {
    return cleanPastedPath(argument);
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const selected = cleanPastedPath(
      await prompt.question('PDF or DOCX path (paste or drag a file here): ')
    );
    if (!selected) {
      throw new Error('A document path is required');
    }
    return selected;
  } finally {
    prompt.close();
  }
}

interface InspectionParser {
  parser: DocumentParser;
  layoutTrace: () => LayoutTrace | undefined;
}

async function parserFor(filename: string): Promise<InspectionParser> {
  const extension = extname(filename).toLowerCase();
  if (extension === '.pdf') {
    const { createPdfParser } = await import('../modules/parsing/pdf-parser.js');
    let trace: LayoutTrace | undefined;
    return {
      parser: createPdfParser({
        onLayoutTrace: (value) => {
          trace = value;
        }
      }),
      layoutTrace: () => trace
    };
  }
  if (extension === '.docx') {
    const { createDocxParser } = await import('../modules/parsing/docx-parser.js');
    return { parser: createDocxParser(), layoutTrace: () => undefined };
  }
  throw new Error(`Unsupported file extension '${extension || '(none)'}'; use PDF or DOCX`);
}

export async function generateParsingInspection(
  input: string,
  output?: string,
  includeLlm = false
): Promise<void> {
  const inputPath = resolve(input);
  const outputPath = resolve(output ?? `${inputPath}.parsing.html`);
  const inspection = await parserFor(inputPath);
  const result = await inspection.parser.parse(new Uint8Array(await readFile(inputPath)));
  const aiInput = buildAiInput(result);
  let supplement: { styles: string; content: string } | undefined;

  if (includeLlm) {
    const [{ config }, { AppDatabase }, llm, extraction, report] = await Promise.all([
      import('../config/config.js'),
      import('../infrastructure/database/database.js'),
      import('../infrastructure/llm/index.js'),
      import('../modules/extraction/index.js'),
      import('../modules/extraction/inspection-report.js')
    ]);
    const database = new AppDatabase();
    let providerOutput: unknown;
    try {
      const llmService = llm.createLlmService(
        llm.createGeminiLlmClient({
          apiKey: config.llm.apiKey,
          maximumInputCharacters: config.llm.maximumInputCharacters
        }),
        llm.createLlmRepository(database)
      );
      const extractionService = extraction.createCandidateExtractionService({
        llmService,
        provider: config.llm.provider,
        model: config.llm.model,
        timeoutMs: config.llm.timeoutMs,
        onProviderOutput: (output) => {
          providerOutput = output;
        }
      });
      const extractionResult = await extractionService.extract({
        operationId: randomUUID(),
        input: aiInput
      });
      supplement = {
        styles: report.EMBEDDED_LLM_INSPECTION_STYLES,
        content: report.buildEmbeddedLlmInspectionReport(
          extractionResult,
          providerOutput
        )
      };
      console.log(`Claims: ${extractionResult.claims.length}`);
      console.log(`Unmapped: ${extractionResult.unmapped.length}`);
    } finally {
      await database.close();
    }
  }

  await writeFile(
    outputPath,
    buildParsingInspectionReport(
      result,
      basename(inputPath),
      inspection.layoutTrace(),
      supplement
    ),
    'utf8'
  );

  console.log(`Parsing status: ${result.status}`);
  console.log(`Report: ${outputPath}`);
}

async function main(): Promise<void> {
  const argumentsWithoutFlags = process.argv.slice(2).filter((value) => value !== '--llm');
  const [inputArgument, outputArgument] = argumentsWithoutFlags;
  const inputPath = await selectInputPath(inputArgument);
  await generateParsingInspection(inputPath, outputArgument, process.argv.includes('--llm'));
}

const executedPath = process.argv[1];
if (executedPath && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  await main();
}
