import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { localModelToRoute } from '../src/catalog.js';
import { startProxyCatalog } from '../src/proxy.js';
import { cachedModelToLocal } from '../src/registry/materialize.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import type { RegistryProvider } from '../src/registry/types.js';
import type { LocalProvider } from '../src/types.js';
import { listen } from './fixtures/account-pool-proxy.js';

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;
let upstream: http.Server;
let upstreamPort: number;
const calls: Array<{ path: string; authorization: string | undefined; model?: string }> = [];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-anonymous-custom-account-'));
  process.env.LEVERFRAME_HOME = home;
  calls.length = 0;
  upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string } : {};
    calls.push({ path: request.url ?? '', authorization: request.headers.authorization, model: body.model });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify({ data: [{ id: 'endpoint-reported-model' }] }));
      return;
    }
    response.end(JSON.stringify({
      id: 'anonymous-chat-response', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'anonymous endpoint response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }));
  });
  upstreamPort = await listen(upstream);

  const provider: RegistryProvider = {
    id: 'custom-anonymous', templateId: 'custom-openai', name: 'Local endpoint', enabled: true,
    authType: 'none', authRef: 'none:anonymous',
    api: { npm: '@ai-sdk/openai-compatible', url: `http://127.0.0.1:${upstreamPort}/v1` },
    addedAt: '2026-11-02',
    modelsCache: {
      fetchedAt: '2026-11-02T00:00:00.000Z',
      models: [{ id: 'primary-cached-model', name: 'Primary cached model', upstreamModelId: 'primary-cached-model', modelFormat: 'openai', npm: '@ai-sdk/openai-compatible' }],
    },
    accounts: [{ id: 'guest', authRef: 'none:anonymous', enabled: true, name: 'Guest endpoint', tag: 'GST' }],
  };
  saveRegistry({ schemaVersion: 1, providers: [provider] });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  rmSync(home, { recursive: true, force: true });
});

function postMessages(port: number, token: string, model: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }] });
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

it('discovers and serves an anonymous custom account without credentials', async () => {
  const refresh = await refreshProviderModels('custom-anonymous', null);

  expect(refresh).toMatchObject({ ok: true, modelSource: 'live', accountResults: [{ accountId: 'guest', ok: true }] });
  expect(calls).toContainEqual({ path: '/v1/models', authorization: undefined });

  const configured = loadRegistry().providers.find(provider => provider.id === 'custom-anonymous')!;
  const cached = configured.accounts?.[0]?.modelsCache?.models[0];
  expect(cached?.id).toBe('endpoint-reported-model');
  expect(configured.modelsCache?.models[0]?.id).toBe('endpoint-reported-model');

  const localModel = cachedModelToLocal(cached!, configured)!;
  const localProvider: LocalProvider = {
    id: configured.id, name: configured.name, apiKey: '', authType: 'none',
    models: [{ ...localModel, accountId: 'guest', accountTag: 'GST', accountName: 'Guest endpoint' }],
  };
  const route = localModelToRoute(localProvider, localProvider.models[0]!);
  expect(route).not.toBeNull();
  const proxy = await startProxyCatalog([route!], route!.aliasId, false);

  try {
    const response = await postMessages(proxy.port, proxy.token, route!.aliasId);
    expect(response.status).toBe(200);
    expect(response.body).toContain('anonymous endpoint response');
    expect(calls).toContainEqual({ path: '/v1/chat/completions', authorization: undefined, model: 'endpoint-reported-model' });
  } finally {
    await proxy.close();
  }
});
