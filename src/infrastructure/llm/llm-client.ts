/**
 * Provider-neutral input for one structured LLM request.
 *
 * Feature modules own the prompt and output schema. Infrastructure adapters
 * only translate this request to their provider's API.
 */
export interface LlmRequest {
  task: string;
  model: string;
  prompt: string;
  input: string;
  outputSchema: object;
  timeoutMs: number;
}

/** Safe provider metadata returned with untrusted model output. */
export interface LlmResponse {
  output: unknown;
  providerRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Boundary implemented by each configured LLM provider adapter. */
export interface LlmClient {
  generate(request: LlmRequest): Promise<LlmResponse>;
}
