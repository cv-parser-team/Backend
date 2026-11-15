export const LLM_ERROR_CATEGORIES = [
  'configuration',
  'authentication',
  'invalid_request',
  'rate_limited',
  'timeout',
  'provider_unavailable',
  'invalid_output'
] as const;

export type LlmErrorCategory = (typeof LLM_ERROR_CATEGORIES)[number];

export class LlmError extends Error {
  readonly name = 'LlmError';

  constructor(
    message: string,
    readonly category: LlmErrorCategory,
    readonly code?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
