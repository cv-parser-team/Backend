import type {
  LlmClient,
  LlmRequest,
  LlmResponse
} from './llm-client.js';
import { LlmError } from './llm.errors.js';
import type { LlmRepository } from './llm.repository.js';

export interface TrackedLlmRequest extends LlmRequest {
  operationId: string;
  provider: string;
  promptVersion: string;
  contractVersion: number;
}

export interface TrackedLlmResponse extends LlmResponse {
  invocationId: string;
}

export interface LlmService {
  generate(request: TrackedLlmRequest): Promise<TrackedLlmResponse>;
}

export function createLlmService(
  client: LlmClient,
  repository: LlmRepository
): LlmService {
  return {
    async generate(request) {
      const invocation = await repository.startInvocation({
        operationId: request.operationId,
        task: request.task,
        provider: request.provider,
        model: request.model,
        promptVersion: request.promptVersion,
        contractVersion: request.contractVersion
      });

      let response: LlmResponse;
      try {
        response = await client.generate({
          task: request.task,
          model: request.model,
          prompt: request.prompt,
          input: request.input,
          outputSchema: request.outputSchema,
          timeoutMs: request.timeoutMs
        });
      } catch (cause) {
        if (cause instanceof LlmError) {
          await repository.failInvocation({
            invocationId: invocation.invocationId,
            errorCategory: cause.category,
            errorCode: cause.code
          });
          throw cause;
        }

        const error = new LlmError(
          'The LLM provider failed unexpectedly',
          'provider_unavailable',
          'UNEXPECTED_PROVIDER_ERROR'
        );
        await repository.failInvocation({
          invocationId: invocation.invocationId,
          errorCategory: error.category,
          errorCode: error.code
        });
        throw error;
      }

      const completed = await repository.completeInvocation({
        invocationId: invocation.invocationId,
        providerRequestId: response.providerRequestId,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens
      });

      if (!completed) {
        throw new Error('LLM invocation completion transition failed');
      }

      return { invocationId: invocation.invocationId, ...response };
    }
  };
}
