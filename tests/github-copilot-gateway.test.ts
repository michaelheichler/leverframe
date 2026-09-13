/** Because gateway shortcuts must not bypass Copilot auth. */
import { afterEach, expect, it, vi } from 'vitest';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { generateOpenAiResponse } from '../src/openai-adapter.js';
import { relayAnthropicMessages } from '../src/upstream-forward.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-copilot-gateway');
vi.mock('../src/provider-factory.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-factory.js')>(),
  createLanguageModel: vi.fn(async () => ({})),
}));
vi.mock('../src/sdk-adapter.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sdk-adapter.js')>(),
  generateAnthropicResponse: vi.fn(async () => ({ id: 'message-test', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })),
}));
vi.mock('../src/openai-adapter.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/openai-adapter.js')>(),
  generateOpenAiResponse: vi.fn(async () => ({ id: 'chat-test', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })),
}));
vi.mock('../src/upstream-forward.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/upstream-forward.js')>(),
  relayAnthropicMessages: vi.fn(async () => { throw new Error('Unwrapped Copilot forwarding is forbidden'); }),
}));
vi.mock('../src/registry/url-security.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/url-security.js')>(),
  revalidateCustomEndpointUrl: vi.fn(async () => ({ ok: true })),
}));

const handles: ServerHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  vi.clearAllMocks();
});

const protocols = [
  { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', completionsUrl: 'https://api.githubcopilot.com/chat/completions' },
  { npm: '@ai-sdk/openai', modelFormat: 'openai' },
  { npm: '@ai-sdk/anthropic', modelFormat: 'anthropic' },
] as const;
const cases = protocols.flatMap(protocol => [
  { ...protocol, endpoint: '/anthropic/v1/messages' },
  { ...protocol, endpoint: '/openai/v1/chat/completions' },
]);

it.each(cases)('routes $npm through the authenticated adapter at $endpoint', async config => {
  const model: ServerModelInfo = {
    ...config, id: 'copilot-native', name: 'Copilot native', isFree: false, brand: 'Other',
    sourceBackend: 'go', providerId: 'github-copilot', authType: 'oauth',
    baseUrl: 'https://api.githubcopilot.com', apiBaseUrl: 'https://api.githubcopilot.com',
  };
  const handle = await startServer({
    host: '127.0.0.1', port: 0, apiKey: globalThis.crypto.randomUUID(), serverPassword: null,
    catalog: createGatewayModelCatalog([model]),
  });
  handles.push(handle);
  const response = await fetch(`${handle.url}${config.endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': globalThis.crypto.randomUUID() },
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'fixture request' }], max_tokens: 8, stream: false }),
  });
  expect(response.status).toBe(200);
  expect(relayAnthropicMessages).not.toHaveBeenCalled();
  expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({ npm: config.npm, providerId: 'github-copilot', authType: 'oauth' }));
  const generate = config.endpoint.startsWith('/anthropic') ? vi.mocked(generateAnthropicResponse) : vi.mocked(generateOpenAiResponse);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0]![1]).toMatchObject({ maxOutputTokens: 8 });
});
