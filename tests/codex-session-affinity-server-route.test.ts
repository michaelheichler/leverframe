import { afterEach, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-codex-session-server');

vi.mock('../src/provider-factory.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/provider-factory.js')>()),
  createLanguageModel: vi.fn(async () => ({})),
}));

vi.mock('../src/sdk-adapter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/sdk-adapter.js')>()),
  generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
    id: 'fixture-message', type: 'message', role: 'assistant', model: modelId,
    content: [{ type: 'text', text: 'fixture response' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  })),
}));

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.mocked(createLanguageModel).mockClear();
  vi.mocked(generateAnthropicResponse).mockClear();
  await closeServer?.();
  closeServer = undefined;
});

it('passes translated session affinity through the native server route', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const catalog = createGatewayModelCatalog([{
    id: 'gpt-session-fixture', name: 'GPT Session Fixture', isFree: false, brand: 'OpenAI',
    providerId: 'openai-oauth', sourceBackend: 'openai-oauth', modelFormat: 'openai',
    npm: '@ai-sdk/openai', authType: 'oauth', apiKey: 'fixture-access-token',
  }]);
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-server-key', serverPassword: null, catalog,
  });
  closeServer = server.close;

  const response = await fetch(`${server.url}/anthropic/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'anthropic-openai-oauth__gpt-session-fixture',
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      messages: [{ role: 'user', content: 'fixture request' }],
    }),
  });

  expect(response.status).toBe(200);
  const params = vi.mocked(generateAnthropicResponse).mock.calls[0]?.[1] as {
    headers?: Record<string, string | undefined>;
    providerOptions?: { openai?: { promptCacheKey?: string } };
  };
  expect(params.headers?.['session-id']).toBe(params.providerOptions?.openai?.promptCacheKey);
  expect(params.headers?.['session-id']).not.toContain(sessionId);
});
