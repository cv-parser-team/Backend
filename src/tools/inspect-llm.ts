import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config/config.js';
import { AppDatabase } from '../infrastructure/database/database.js';
import {
  createGeminiLlmClient,
  createLlmRepository,
  createLlmService,
  LlmError
} from '../infrastructure/llm/index.js';
import { createCandidateExtractionService } from '../modules/extraction/index.js';
import { buildLlmInspectionReport } from '../modules/extraction/inspection-report.js';

const inspectionInput = `[P1 R0 independent]
## L1 Samira Haddad
L2 Backend Engineer
L3 samira.haddad@example.com
[P1 R1 section]
## L4 Experience
L5 Senior Backend Engineer | Example Labs
L6 January 2022 - Present
L7 Built TypeScript services backed by PostgreSQL.
[P1 R2 section]
## L8 Skills
L9 TypeScript, PostgreSQL
[P1 R3 section]
## L10 Awards
L11 Engineering Excellence Award, 2024`;

async function main(): Promise<void> {
  let database: AppDatabase | undefined;
  let providerOutput: unknown;
  try {
    const client = createGeminiLlmClient({
      apiKey: config.llm.apiKey,
      maximumInputCharacters: config.llm.maximumInputCharacters
    });
    database = new AppDatabase();
    const llmService = createLlmService(
      client,
      createLlmRepository(database)
    );
    const extractionService = createCandidateExtractionService({
      llmService,
      provider: config.llm.provider,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      onProviderOutput: (output) => {
        providerOutput = output;
      }
    });
    const result = await extractionService.extract({
      operationId: randomUUID(),
      input: inspectionInput
    });
    const outputPath = resolve(process.argv[2] ?? 'llm-inspection.html');

    await writeFile(
      outputPath,
      buildLlmInspectionReport(result, inspectionInput, providerOutput),
      'utf8'
    );
    console.log(`Claims: ${result.claims.length}`);
    console.log(`Unmapped: ${result.unmapped.length}`);
    console.log(`Report: ${outputPath}`);
  } catch (error) {
    if (error instanceof LlmError) {
      console.error(
        JSON.stringify({ category: error.category, code: error.code })
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await database?.close();
  }
}

await main();
