import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';

const { resolveAntigravityAuth } = vi.hoisted(() => ({ resolveAntigravityAuth: vi.fn() }));
vi.mock('../src/antigravity/auth.js', () => ({ resolveAntigravityAuth }));

import { createAntigravityLanguageModel } from '../src/antigravity/provider.js';

afterEach(() => vi.resetAllMocks());

describe('Antigravity Google language model', () => {
  it('generates through the account subscription transport', async () => {
    resolveAntigravityAuth.mockResolvedValue({
      accessToken: 'account-a-access', accountId: 'account-a', projectId: 'project-a',
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'hello from Gemini' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 3 },
    } }));
    const model = await createAntigravityLanguageModel({
      modelId: 'gemini-3.1-pro-high', expectedAccountId: 'account-a', fetchImpl,
    });

    const result = await generateText({ model, prompt: 'Reply with hello from Gemini' });

    expect(result.text).toBe('hello from Gemini');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const input = fetchImpl.mock.calls[0]![0];
    expect(input instanceof Request ? input.url : String(input))
      .toContain('daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
  });

  it('rejects an account change before inference', async () => {
    resolveAntigravityAuth.mockResolvedValue({
      accessToken: 'account-b-access', accountId: 'account-b', projectId: 'project-b',
    });
    const fetchImpl = vi.fn(async () => Response.json({}));
    const model = await createAntigravityLanguageModel({
      modelId: 'gemini-3.1-pro-high', expectedAccountId: 'account-a', fetchImpl,
    });

    await expect(generateText({ model, prompt: 'hello' })).rejects.toThrow(/account/i);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
