import { LlmClient, LlmRequest, LlmResponse } from './llm-client.js';
import { LlmError, LlmErrorCategory } from './llm.errors.js';

const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

type Fetch = typeof fetch;

export interface GeminiLlmClientOptions {
  apiKey?: string;
  maximumInputCharacters: number;
  fetch?: Fetch;
}

interface GeminiErrorBody {
  error?: {
    status?: unknown;
    details?: unknown;
  };
}

interface GeminiResponseBody {
  responseId?: unknown;
  candidates?: unknown;
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
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

function providerErrorCode(body: GeminiErrorBody): string | undefined {
  const details = body.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (isRecord(detail) && typeof detail.reason === 'string') {
        return detail.reason;
      }
    }
  }

  const status = body.error?.status;
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

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (!response.ok) {
      throw new LlmError(
        'The LLM provider rejected the request',
        categoryForStatus(response.status),
        undefined,
        { cause }
      );
    }
    throw new LlmError(
      'The LLM provider returned unreadable JSON',
      'invalid_output',
      undefined,
      { cause }
    );
  }
}

function candidateText(body: GeminiResponseBody): string | undefined {
  if (!Array.isArray(body.candidates)) {
    return undefined;
  }

  for (const candidate of body.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) {
      continue;
    }
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    const text = parts
      .filter(isRecord)
      .map((part) => part.text)
      .filter((part): part is string => typeof part === 'string')
      .join('');
    return text || undefined;
  }

  return undefined;
}

function modelName(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
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

  const fetchRequest = options.fetch ?? globalThis.fetch;

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
      let response: Response;

      try {
        const model = encodeURIComponent(modelName(request.model));
        response = await fetchRequest(
          `${GEMINI_API_ROOT}/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-goog-api-key': apiKey
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: request.prompt }] },
              contents: [{ role: 'user', parts: [{ text: request.input }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: request.outputSchema
              }
            }),
            signal: abortController.signal
          }
        );
      } catch (cause) {
        if (abortController.signal.aborted) {
          throw new LlmError('The LLM provider request timed out', 'timeout', undefined, {
            cause
          });
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

      const rawBody = await readBody(response);
      const body: GeminiResponseBody & GeminiErrorBody = isRecord(rawBody)
        ? rawBody
        : {};
      if (!response.ok) {
        const code = providerErrorCode(body);
        throw new LlmError(
          'The LLM provider rejected the request',
          categoryForStatus(response.status, code),
          code
        );
      }

      const text = candidateText(body);
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
        providerRequestId:
          typeof body.responseId === 'string' ? body.responseId : undefined,
        inputTokens: optionalNonnegativeInteger(
          body.usageMetadata?.promptTokenCount
        ),
        outputTokens: optionalNonnegativeInteger(
          body.usageMetadata?.candidatesTokenCount
        )
      };
    }
  };
}
