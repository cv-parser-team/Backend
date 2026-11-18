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

// Asks the AI about the PDF's uncertain layout decisions and returns the
// rebuilt trace with a report section listing every decision.
async function adjudicateLayout(
  content: Uint8Array
): Promise<{ trace: LayoutTrace; styles: string; content: string }> {
  const [{ config }, { AppDatabase }, llm, ai, run, report] = await Promise.all([
    import('../config/config.js'),
    import('../infrastructure/database/database.js'),
    import('../infrastructure/llm/index.js'),
    import('../modules/parsing/parsing-adjudication.ai.js'),
    import('../modules/parsing/parsing-adjudication.run.js'),
    import('../modules/parsing/parsing-adjudication.report.js')
  ]);
  const database = new AppDatabase();
  try {
    const adjudicator = ai.createAiAdjudicator({
      llmService: llm.createLlmService(
        llm.createGeminiLlmClient({
          apiKey: config.llm.apiKey,
          maximumInputCharacters: config.llm.maximumInputCharacters
        }),
        llm.createLlmRepository(database)
      ),
      provider: config.llm.provider,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs
    });
    const layout = await run.adjudicatePdfLayout(content, adjudicator, randomUUID());
    const applied = layout.result.decisions.filter((decision) => decision.source === 'ai').length;
    console.log(`Uncertain decisions: ${layout.cases.length}, AI choices applied: ${applied}`);
    return {
      trace: layout.adjudicated,
      styles: report.ADJUDICATION_REPORT_STYLES,
      content: report.buildAdjudicationReport(layout.initial, layout.cases, layout.result)
    };
  } finally {
    await database.close();
  }
}

export async function generateParsingInspection(
  input: string,
  output?: string,
  includeLlm = false,
  adjudicate = false
): Promise<void> {
  const inputPath = resolve(input);
  const outputPath = resolve(output ?? `${inputPath}.parsing.html`);
  const inspection = await parserFor(inputPath);
  const content = new Uint8Array(await readFile(inputPath));
  const result = await inspection.parser.parse(content);
  const aiInput = buildAiInput(result);
  let supplement: { styles: string; content: string } | undefined;
  let layoutTrace = inspection.layoutTrace();

  if (adjudicate && layoutTrace) {
    const adjudicated = await adjudicateLayout(content);
    layoutTrace = adjudicated.trace;
    supplement = { styles: adjudicated.styles, content: adjudicated.content };
  }

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
        styles: `${supplement?.styles ?? ''}${report.EMBEDDED_LLM_INSPECTION_STYLES}`,
        content: `${supplement?.content ?? ''}${report.buildEmbeddedLlmInspectionReport(
          extractionResult,
          providerOutput
        )}`
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
      layoutTrace,
      supplement
    ),
    'utf8'
  );

  console.log(`Parsing status: ${result.status}`);
  console.log(`Report: ${outputPath}`);
}

async function main(): Promise<void> {
  const flags = ['--llm', '--adjudicate'];
  const argumentsWithoutFlags = process.argv.slice(2).filter((value) => !flags.includes(value));
  const [inputArgument, outputArgument] = argumentsWithoutFlags;
  const inputPath = await selectInputPath(inputArgument);
  await generateParsingInspection(
    inputPath,
    outputArgument,
    process.argv.includes('--llm'),
    process.argv.includes('--adjudicate')
  );
}

const executedPath = process.argv[1];
if (executedPath && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  await main();
}
