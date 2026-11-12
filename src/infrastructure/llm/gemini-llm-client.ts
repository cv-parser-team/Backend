import { ApiError, GoogleGenAI } from '@google/genai';
import { LlmClient, LlmRequest, LlmResponse } from './llm-client.js';
import { LlmError, LlmErrorCategory } from './llm.errors.js';

type Fetch = typeof fetch;

export interface GeminiLlmClientOptions {
  apiKey?: string;
  maximumInputCharacters: number;
  fetch?: Fetch;
}

interface ProviderErrorBody {
  error?: {
    status?: unknown;
    details?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function providerErrorCode(error: ApiError): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(error.message);
  } catch {
    return undefined;
  }
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }

  const providerError = body as ProviderErrorBody;
  const details = providerError.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (isRecord(detail) && typeof detail.reason === 'string') {
        return detail.reason;
      }
    }
  }

  const status = providerError.error?.status;
  return typeof status === 'string' ? status : undefined;
}

function categoryForStatus(status: number, code?: string): LlmErrorCategory {
  if (code === 'API_KEY_INVALID' || code === 'UNAUTHENTICATED') {
    return 'authentication';
  }
  if (status === 401 || status === 403) {
    return 'authentication';
  }
  if (status === 408 || status === 504) {
    return 'timeout';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 500) {
    return 'provider_unavailable';
  }
  return 'invalid_request';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export function createGeminiLlmClient(
  options: GeminiLlmClientOptions
): LlmClient {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new LlmError(
      'Gemini API credentials are not configured',
      'configuration',
      'MISSING_API_KEY'
    );
  }
  if (
    !Number.isSafeInteger(options.maximumInputCharacters) ||
    options.maximumInputCharacters <= 0
  ) {
    throw new LlmError(
      'The LLM input limit must be a positive integer',
      'configuration',
      'INVALID_INPUT_LIMIT'
    );
  }

  const gemini = new GoogleGenAI({
    apiKey,
    httpOptions: {
      fetch: options.fetch,
      retryOptions: { attempts: 1 }
    }
  });

  return {
    async generate(request: LlmRequest): Promise<LlmResponse> {
      if (request.input.length > options.maximumInputCharacters) {
        throw new LlmError(
          'The LLM input exceeds the configured limit',
          'invalid_request',
          'INPUT_TOO_LARGE'
        );
      }
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
        throw new LlmError(
          'The LLM timeout must be a positive integer',
          'configuration',
          'INVALID_TIMEOUT'
        );
      }

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), request.timeoutMs);

      try {
        const response = await gemini.models.generateContent({
          model: request.model,
          contents: request.input,
          config: {
            systemInstruction: request.prompt,
            responseMimeType: 'application/json',
            responseJsonSchema: request.outputSchema,
            automaticContinuation: false,
            abortSignal: abortController.signal,
            httpOptions: {
              timeout: request.timeoutMs,
              retryOptions: { attempts: 1 }
            }
          }
        });

        const text = response.text;
        if (text === undefined) {
          throw new LlmError(
            'The LLM provider returned no structured output',
            'invalid_output',
            'MISSING_OUTPUT'
          );
        }

        let output: unknown;
        try {
          output = JSON.parse(text);
        } catch (cause) {
          throw new LlmError(
            'The LLM provider returned invalid structured output',
            'invalid_output',
            'INVALID_JSON',
            { cause }
          );
        }

        return {
          output,
          providerRequestId: response.responseId,
          inputTokens: optionalNonnegativeInteger(
            response.usageMetadata?.promptTokenCount
          ),
          outputTokens: optionalNonnegativeInteger(
            response.usageMetadata?.candidatesTokenCount
          )
        };
      } catch (cause) {
        if (cause instanceof LlmError) {
          throw cause;
        }
        if (abortController.signal.aborted || isAbortError(cause)) {
          throw new LlmError(
            'The LLM provider request timed out',
            'timeout',
            undefined,
            { cause }
          );
        }
        if (cause instanceof ApiError) {
          const code = providerErrorCode(cause);
          throw new LlmError(
            'The LLM provider rejected the request',
            categoryForStatus(cause.status, code),
            code
          );
        }
        throw new LlmError(
          'The LLM provider could not be reached',
          'provider_unavailable',
          undefined,
          { cause }
        );
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}
