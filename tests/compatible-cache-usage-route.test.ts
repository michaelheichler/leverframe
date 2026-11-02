import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderModelSpec } from '../src/language-model-factory.js';
import { createModelCatalog } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('../src/registry/url-security.js', () => ({
  revalidateCustomEndpointUrl: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: ProviderModelSpec) => {
      const factory = await import('../src/language-model-factory.js');
      return factory.createLanguageModel({ ...spec, fetch: fixture.fetch as typeof fetch });
    }),
  };
});

let server: ServerHandle | undefined;
let testHome: string | undefined;
let previousHome: string | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  fixture.fetch.mockReset();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  previousHome = undefined;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = undefined;
});

it('writes compatible cache read and TTL usage to the inference lifecycle log', async () => {
  testHome = mkdtempSync(join(tmpdir(), 'compatible-usage-log-'));
  previousHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = testHome;
  const logPath = join(testHome, 'inference.jsonl');
  fixture.fetch.mockResolvedValue(Response.json({
    id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: 'go-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fixture reply' } }],
    usage: {
      prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      opencode: { tokens: { input: 80, output: 5, reasoning: 3, cache_read: 20, cache_write_5m: 4, cache_write_1h: 6 } },
    },
  }));
  const catalog = createModelCatalog([{
    id: 'go-model', name: 'fixture model', isFree: false, brand: 'fixture', sourceBackend: 'opencode-go',
    modelFormat: 'openai', npm: '@ai-sdk/openai-compatible', apiBaseUrl: 'https://opencode.ai/zen/go/v1',
    providerId: 'opencode-go', authType: 'api', apiKey: 'fixture-sentinel',
  }]);
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'gateway-sentinel', serverPassword: null,
    catalog, inferenceLogPath: logPath,
  });

  const response = await fetch(`${server.url}/anthropic/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'go-model', messages: [{ role: 'user', content: 'fixture prompt' }] }),
  });
  const responseBody = await response.json() as { usage: Record<string, unknown> };
  const logs = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  const usageLog = logs.find(entry => entry.event === 'response_usage');

  expect(response.status).toBe(200);
  expect(responseBody.usage).not.toHaveProperty('cache_creation_5m_input_tokens');
  expect(usageLog).toMatchObject({
    route: 'translated', inputTokens: 80, outputTokens: 5, cacheReadInputTokens: 20,
    cacheCreationInputTokens: 10, cacheCreation5mInputTokens: 4, cacheCreation1hInputTokens: 6,
  });
  expect(usageLog).not.toHaveProperty('opencode');
});
