import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import { OPENCODE_ZEN_BASE_URL } from '../src/opencode-zen.js';
import { getProvidersPath } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import { loadRegistryProviders } from '../src/registry/load.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';

const providerId = 'custom-public-models';
const modelId = 'alias-free-fixture';
const originalFetch = globalThis.fetch;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function configureAlias() {
  const home = process.env['LEVERFRAME_TEST_HOME'];
  if (!home) throw new Error('isolated test home is missing');
  vi.stubEnv('LEVERFRAME_HOME', join(home, randomUUID()));
  const part = relative(resolve(home), resolve(getProvidersPath()));
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('registry fixture escaped test home');
  const suppliedCredential = randomUUID();
  vi.stubEnv('LEVERFRAME_ZEN_ALIAS_TEST_CREDENTIAL', suppliedCredential);
  vi.stubEnv('LEVERFRAME_ZEN_ALIAS_SECOND_CREDENTIAL', randomUUID());
  saveRegistry({ schemaVersion: 1, providers: [{
    id: providerId, templateId: 'opencode-zen', name: 'Custom public models', enabled: true,
    authType: 'api', authRef: 'env:LEVERFRAME_ZEN_ALIAS_TEST_CREDENTIAL',
    api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_ZEN_BASE_URL,
      headers: { 'x-api-key': suppliedCredential } }, addedAt: '2026-11-12T00:00:00.000Z',
    accounts: [
      { id: 'first', authRef: 'env:LEVERFRAME_ZEN_ALIAS_TEST_CREDENTIAL', enabled: true },
      { id: 'second', authRef: 'env:LEVERFRAME_ZEN_ALIAS_SECOND_CREDENTIAL', enabled: true,
        modelsCache: { fetchedAt: '2026-11-12T00:00:00.000Z', models: [{ id: modelId, name: 'Alias free fixture',
          upstreamModelId: modelId, npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', isFree: true }] } },
    ],
    modelsCache: { fetchedAt: '2026-11-12T00:00:00.000Z', models: [{ id: modelId, name: 'Alias free fixture',
      upstreamModelId: modelId, npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', isFree: true }] },
  }] });
  return suppliedCredential;
}

function interceptZen(status: number) {
  const calls: Array<{ url: string; method: string | undefined; authorization: string | null; apiKey: string | null }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method, authorization: headers.get('authorization'), apiKey: headers.get('x-api-key') });
    if (status !== 200) return Response.json({ error: { type: 'FreeUsageLimitError', message: 'Free model limit reached.' } },
      { status, headers: { 'Retry-After': '120' } });
    return Response.json({ id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: modelId,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'accepted' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  return calls;
}

async function aliasServer() {
  const providers = await loadRegistryProviders();
  const server = await startServer({ host: '127.0.0.1', port: 0, apiKey: randomUUID(), serverPassword: null,
    catalog: createGatewayModelCatalog(localProvidersToServerModels(providers)) });
  onTestFinished(() => server.close());
  return server;
}

it('keeps supplied credentials out of Zen inference when the registry provider uses a custom id', async () => {
  const suppliedCredential = configureAlias();
  const calls = interceptZen(200);
  const server = await aliasServer();

  const response = await originalFetch(`${server.url}/openai/v1/chat/completions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply accepted' }] }) });
  await response.text();

  expect(response.status).toBe(200);
  expect(calls).toEqual([{ url: `${OPENCODE_ZEN_BASE_URL}/chat/completions`, method: 'POST',
    authorization: 'Bearer public', apiKey: null }]);
  expect(JSON.stringify(calls)).not.toContain(suppliedCredential);
});

it.each(['/openai/v1/chat/completions', '/anthropic/v1/messages'])(
  'preserves the Zen single-attempt policy for a custom provider through %s', async path => {
    configureAlias();
    const calls = interceptZen(429);
    const server = await aliasServer();

    const response = await originalFetch(`${server.url}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Claude-Code-Session-Id': randomUUID() },
      body: JSON.stringify({ model: modelId, max_tokens: 20, messages: [{ role: 'user', content: 'Reply accepted' }] }) });
    await response.text();

    expect(response.status).toBe(429);
    expect(calls).toHaveLength(1);
  },
);
