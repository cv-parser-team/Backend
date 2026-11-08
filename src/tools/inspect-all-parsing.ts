import { readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateParsingInspection } from './inspect-parsing.js';

export function selectInspectionInputNames(names: readonly string[]): string[] {
  return names
    .filter((name) => {
      const extension = extname(name).toLowerCase();
      return extension === '.pdf' || extension === '.docx';
    })
    .sort();
}

async function main(): Promise<void> {
  const directory = resolve(process.argv[2] ?? 'testResumes');
  const entries = await readdir(directory, { withFileTypes: true });
  const inputNames = selectInspectionInputNames(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  );

  if (inputNames.length === 0) {
    throw new Error(`No PDF or DOCX files found in ${directory}`);
  }

  for (const inputName of inputNames) {
    console.log(`Inspecting ${inputName}`);
    await generateParsingInspection(resolve(directory, inputName));
  }

  console.log(`Generated ${inputNames.length} parsing inspection reports`);
}

const executedPath = process.argv[1];
if (executedPath && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  await main();
}
