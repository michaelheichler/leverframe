import { describe, expect, it, vi } from 'vitest';
import { fetchAntigravityModels } from '../src/antigravity/models.js';
import type { AntigravityAuthSnapshot } from '../src/antigravity/types.js';

const auth: AntigravityAuthSnapshot = {
  accessToken: 'account-a-token', accountId: 'account-a', projectId: 'project-a',
};

function catalogResponse(models: Record<string, unknown>): Response {
  return Response.json({ models });
}

describe('Antigravity account model catalog', () => {
  it('returns only Gemini models keyed by the exact account model ID', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => catalogResponse({
      'gemini-3.1-pro-high': {
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', displayName: 'Gemini 3.1 Pro High',
        model: 'MODEL_PLACEHOLDER_M', maxTokens: 1_000_000, maxOutputTokens: 65_536,
        quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-01T12:00:00Z' },
      },
      'private-helper-model': {
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', displayName: 'Internal Helper', isInternal: true,
      },
      'claude-sonnet-4-6': {
        apiProvider: 'API_PROVIDER_ANTHROPIC', displayName: 'Claude Sonnet',
      },
      'unknown-provider-model': { displayName: 'Unknown Provider' },
    }));

    const [model] = await fetchAntigravityModels(auth, { fetchImpl });

    expect(model).toMatchObject({
      id: 'gemini-3.1-pro-high',
      upstreamModelId: 'gemini-3.1-pro-high',
      name: 'Gemini 3.1 Pro High',
      modelFormat: 'cloud-code',
      npm: '@ai-sdk/google',
      outputTokenLimit: 65_536,
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
    expect(model).not.toHaveProperty('isFree');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer account-a-token');
    expect(JSON.parse(String(init?.body))).toEqual({ project: 'project-a' });
  });

  it('does not report maxTokens as a verified input context window', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => catalogResponse({
      'gemini-3.1-pro-low': {
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', maxTokens: 1_000_000, maxOutputTokens: 65_536,
      },
    }));

    const [model] = await fetchAntigravityModels(auth, { fetchImpl });

    expect(model).toMatchObject({ contextWindow: undefined, contextWindowUnconfirmed: true });
  });

  it('rejects an invalid or empty model map', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ models: [] }));

    await expect(fetchAntigravityModels(auth, { fetchImpl })).rejects.toThrow(/catalog|model/i);
  });

  it('preserves model quota as account snapshot metadata without inventing price', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => catalogResponse({
      'gemini-3.1-pro-medium': {
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', displayName: 'Gemini 3.1 Pro Medium',
        quotaInfo: { remainingFraction: 0.25, resetTime: '2026-11-01T12:00:00Z' },
      },
    }));

    const [model] = await fetchAntigravityModels(auth, { fetchImpl });

    expect(model).not.toHaveProperty('cost');
    expect(model).not.toHaveProperty('isFree');
  });
});
