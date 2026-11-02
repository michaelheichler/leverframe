import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { reserveAccount } from '../src/account-pool.js';
import { savePreferences } from '../src/config.js';
import type { ProxyRoute } from '../src/proxy.js';
import { saveRegistry } from '../src/registry/io.js';

const sdkMocks = vi.hoisted(() => ({ stream: vi.fn(), createModel: vi.fn() }));

vi.mock('../src/sdk-adapter.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sdk-adapter.js')>(),
  streamAnthropicResponse: sdkMocks.stream,
}));
vi.mock('../src/provider-factory.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-factory.js')>(),
  createLanguageModel: sdkMocks.createModel,
}));
vi.mock('../src/registry/url-security.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/url-security.js')>(),
  revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
}));

import { startProxyCatalog as startProxy } from '../src/proxy.js';

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-sdk-provider-observation-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('KIMI_ALPHA_FIXTURE', 'kimi-alpha-key');
  vi.stubEnv('KIMI_BETA_FIXTURE', 'kimi-beta-key');
  sdkMocks.stream.mockReset();
  sdkMocks.createModel.mockReset().mockResolvedValue({});
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'kimi', templateId: 'kimi', name: 'Kimi', enabled: true, authType: 'api',
    authRef: 'env:KIMI_ALPHA_FIXTURE', api: { npm: '@ai-sdk/openai-compatible' }, addedAt: '2026-11-02',
    accounts: [
      { id: 'alpha', authRef: 'env:KIMI_ALPHA_FIXTURE', enabled: true },
      { id: 'beta', authRef: 'env:KIMI_BETA_FIXTURE', enabled: true },
    ],
  }] });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function kimiRoute(): ProxyRoute {
  return {
    aliasId: 'leverframe:kimi:model-fixture', realModelId: 'model-fixture',
    displayName: 'Kimi model', upstreamUrl: '', apiKey: 'route-snapshot-key',
    modelFormat: 'openai', npm: '@ai-sdk/openai-compatible', baseURL: 'https://api.kimi.example/v1',
    providerId: 'kimi', authType: 'api',
  };
}

function postStream(port: number, token: string, model: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'fixture' }], stream: true });
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function throttleAfterPartialOutput(): APICallError {
  return new APICallError({
    message: 'Provider rate limit reached after partial output.',
    url: 'https://api.kimi.example/v1/chat/completions', requestBodyValues: {}, statusCode: 429,
    responseBody: JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limited' } }), isRetryable: false,
  });
}

it('records post-header quota failure under the selected API provider without replaying output', async () => {
  const route = kimiRoute();
  sdkMocks.stream.mockImplementationOnce(async (...args: unknown[]) => {
    const writeChunk = args[3] as (chunk: string) => void;
    writeChunk('event: message_start\ndata: {"type":"message_start"}\n\n');
    throw throttleAfterPartialOutput();
  });
  const proxy = await startProxy([route], route.aliasId, false);

  try {
    const response = await postStream(proxy.port, proxy.token, route.aliasId);
    const modelOptions = sdkMocks.createModel.mock.calls[0]?.[0] as {
      apiKey: string; providerData?: Record<string, unknown>;
    };
    const next = await reserveAccount({
      pool: { providerId: 'kimi', modelId: route.realModelId, billingType: 'api' },
      accounts: [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }],
      balancing: false, now: Date.now(),
    });

    expect(response.status, response.body).toBe(200);
    expect(response.body).toContain('message_start');
    expect(sdkMocks.stream).toHaveBeenCalledTimes(1);
    expect(sdkMocks.createModel).toHaveBeenCalledTimes(1);
    expect(modelOptions).toMatchObject({ apiKey: 'kimi-alpha-key', providerData: { leverframeAccountId: 'alpha' } });
    expect(next).toMatchObject({ kind: 'reserved', reservation: { accountId: 'beta' } });
  } finally {
    await proxy.close();
  }
});
