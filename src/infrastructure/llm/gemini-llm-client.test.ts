import { describe, expect, it, vi } from 'vitest';
import { createGeminiLlmClient } from './gemini-llm-client.js';
import { LlmError } from './llm.errors.js';

const request = {
  task: 'inspection',
  model: 'gemini-test',
  prompt: 'Return the value.',
  input: 'The value is 3.',
  outputSchema: {
    type: 'object',
    properties: { value: { type: 'integer' } },
    required: ['value']
  },
  timeoutMs: 1_000
};

function clientWith(fetch: typeof globalThis.fetch) {
  return createGeminiLlmClient({
    apiKey: 'test-key',
    maximumInputCharacters: 1_000,
    fetch
  });
}

describe('Gemini LLM client', () => {
  it('requires credentials only when the Gemini client is created', () => {
    expect(() =>
      createGeminiLlmClient({
        maximumInputCharacters: 1_000
      })
    ).toThrowError(
      expect.objectContaining({
        category: 'configuration',
        code: 'MISSING_API_KEY'
      })
    );
  });

  it('returns parsed unknown output and safe provider metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"value":3}' }] } }
          ],
          responseId: 'provider-request-1',
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 5
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(clientWith(fetch).generate(request)).resolves.toEqual({
      output: { value: 3 },
      providerRequestId: 'provider-request-1',
      inputTokens: 12,
      outputTokens: 5
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('maps an invalid API key without exposing the provider response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            status: 'INVALID_ARGUMENT',
            details: [{ reason: 'API_KEY_INVALID' }]
          }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );

    const error = await clientWith(fetch).generate(request).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({
      message: 'The LLM provider rejected the request',
      category: 'authentication',
      code: 'API_KEY_INVALID'
    });
  });

  it('rejects oversized input before calling the provider', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createGeminiLlmClient({
      apiKey: 'test-key',
      maximumInputCharacters: 3,
      fetch
    });

    await expect(client.generate(request)).rejects.toMatchObject({
      category: 'invalid_request',
      code: 'INPUT_TOO_LARGE'
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
