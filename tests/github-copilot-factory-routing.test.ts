/** Because Copilot OAuth must not reach another provider. */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { afterEach, expect, it, vi } from 'vitest';
import { createLanguageModel } from '../src/provider-factory.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  { npm: '@ai-sdk/openai-compatible', path: '/chat/completions' },
  { npm: '@ai-sdk/openai', path: '/responses' },
  { npm: '@ai-sdk/anthropic', path: '/v1/messages' },
  { npm: '@github/copilot-sdk', path: '/chat/completions' },
])('routes Copilot $npm to its own API rather than a vendor runtime', async ({ npm, path }) => {
  const credential = globalThis.crypto.randomUUID();
  let sent: Request | undefined;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    sent = new Request(input, init);
    return Response.json({ error: { message: 'fixture rejection' } }, { status: 400 });
  }));
  const model = await createLanguageModel({
    npm, providerId: 'github-copilot', authType: 'oauth',
    modelId: 'copilot-test-model', apiKey: credential,
  }) as LanguageModelV4;
  await expect(model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }], maxOutputTokens: 8,
  })).rejects.toThrow();
  expect(sent?.url).toBe(`https://api.githubcopilot.com${path}`);
  expect(sent?.headers.get('authorization')).toBe(`Bearer ${credential}`);
  expect(sent?.headers.has('editor-version')).toBe(true);
});
