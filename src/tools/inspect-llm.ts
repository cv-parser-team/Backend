import { config } from '../config/config.js';
import {
  createGeminiLlmClient,
  LlmError
} from '../infrastructure/llm/index.js';

const inspectionSchema = {
  type: 'object',
  properties: {
    landmark: { type: 'string' },
    heightMetres: { type: 'integer' }
  },
  required: ['landmark', 'heightMetres'],
  additionalProperties: false
} as const;

async function main(): Promise<void> {
  try {
    const client = createGeminiLlmClient({
      apiKey: config.llm.apiKey,
      maximumInputCharacters: config.llm.maximumInputCharacters
    });
    const result = await client.generate({
      task: 'llm_inspection',
      model: config.llm.model,
      prompt: 'Extract the stated landmark and its height. Do not infer missing values.',
      input: 'The synthetic landmark is Cedar Tower. Its height is 37 metres.',
      outputSchema: inspectionSchema,
      timeoutMs: config.llm.timeoutMs
    });

    console.log(
      JSON.stringify(
        {
          output: result.output,
          providerRequestId: result.providerRequestId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens
        },
        null,
        2
      )
    );
  } catch (error) {
    if (error instanceof LlmError) {
      console.error(
        JSON.stringify({ category: error.category, code: error.code })
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

await main();
