import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildParsingInspectionReport } from '../modules/parsing/inspection-report.js';
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

const [, , inputArgument, outputArgument] = process.argv;
const inputPath = resolve(await selectInputPath(inputArgument));
const outputPath = resolve(outputArgument ?? `${inputPath}.parsing.html`);
const inspection = await parserFor(inputPath);
const result = await inspection.parser.parse(new Uint8Array(await readFile(inputPath)));

await writeFile(
  outputPath,
  buildParsingInspectionReport(result, basename(inputPath), inspection.layoutTrace()),
  'utf8'
);

console.log(`Parsing status: ${result.status}`);
console.log(`Report: ${outputPath}`);
