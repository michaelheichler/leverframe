import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderModelSpec } from '../src/language-model-factory.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
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

function goInferenceLogPath() {
  testHome = mkdtempSync(join(tmpdir(), 'compatible-usage-log-'));
  previousHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = testHome;
  const logPath = join(testHome, 'inference.jsonl');
  return logPath;
}

function fixtureGoResponse() {
  return Response.json({
    id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: 'go-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fixture reply' } }],
    usage: {
      prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      opencode: {
        billing_source: 'go', allowance: 0.00412,
        tokens: { input: 80, output: 5, reasoning: 3, cache_read: 20, cache_write_5m: 4, cache_write_1h: 6 },
      },
    },
  });
}

function readUsageLog(path: string, event: string) {
  const logs = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  return logs.find(entry => entry.event === event);
}

it('writes Go cache reads, TTL usage, and allowance to the inference lifecycle log', async () => {
  const logPath = goInferenceLogPath();
  fixture.fetch.mockResolvedValue(fixtureGoResponse());
  const catalog = createModelCatalog([{
    id: 'go-model', name: 'fixture model', isFree: false, brand: 'fixture', sourceBackend: 'opencode-go',
    modelFormat: 'openai', npm: '@ai-sdk/openai-compatible', apiBaseUrl: 'https://opencode.ai/inference/go/v1',
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
  const usageLog = readUsageLog(logPath, 'response_usage');

  expect(response.status).toBe(200);
  expect(responseBody.usage).not.toHaveProperty('cache_creation_5m_input_tokens');
  expect(responseBody.usage).not.toHaveProperty('openCodeGoAllowanceUsd');
  expect(usageLog).toMatchObject({
    route: 'translated', inputTokens: 80, outputTokens: 5, cacheReadInputTokens: 20,
    cacheCreationInputTokens: 10, cacheCreation5mInputTokens: 4, cacheCreation1hInputTokens: 6,
    openCodeGoAllowanceUsd: 0.00412,
  });
  expect(usageLog).not.toHaveProperty('opencode');
  expect(fixture.fetch.mock.calls).toEqual([[
    'https://opencode.ai/inference/go/v1/chat/completions', expect.objectContaining({ method: 'POST' }),
  ]]);
});

it('records provider cache reads and allowance on the regular Claude proxy path', async () => {
  const logPath = goInferenceLogPath();
  fixture.fetch.mockResolvedValue(fixtureGoResponse());
  const route: ProxyRoute = {
    aliasId: 'leverframe:opencode-go:go-model', realModelId: 'go-model', displayName: 'fixture model',
    upstreamUrl: '', apiKey: 'fixture-sentinel', modelFormat: 'openai', npm: '@ai-sdk/openai-compatible',
    baseURL: 'https://opencode.ai/inference/go/v1', providerId: 'opencode-go', authType: 'api',
  };
  const proxy = await startProxyCatalog([route], route.aliasId, false, logPath);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: route.aliasId, messages: [{ role: 'user', content: 'fixture prompt' }] }),
    });
    const body = await response.json() as { usage: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.usage).not.toHaveProperty('openCodeGoAllowanceUsd');
    expect(readUsageLog(logPath, 'upstream_usage')).toMatchObject({
      route: 'translated', provider: 'opencode-go', inputTokens: 80, outputTokens: 5, cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10, cacheCreation5mInputTokens: 4, cacheCreation1hInputTokens: 6,
      openCodeGoAllowanceUsd: 0.00412,
    });
    expect(fixture.fetch.mock.calls).toEqual([[
      'https://opencode.ai/inference/go/v1/chat/completions', expect.objectContaining({ method: 'POST' }),
    ]]);
  } finally {
    await proxy.close();
  }
});
