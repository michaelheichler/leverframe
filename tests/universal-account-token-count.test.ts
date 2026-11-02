import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';
import { listen } from './fixtures/account-pool-proxy.js';

const previousHome = process.env.LEVERFRAME_HOME;
const previousPrimary = process.env.ANTHROPIC_PRIMARY_FIXTURE;
const previousSecondary = process.env.ANTHROPIC_SECONDARY_FIXTURE;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-token-count-'));
  process.env.LEVERFRAME_HOME = home;
  process.env.ANTHROPIC_PRIMARY_FIXTURE = 'primary-api-key';
  process.env.ANTHROPIC_SECONDARY_FIXTURE = 'secondary-api-key';
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: false });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousPrimary === undefined) delete process.env.ANTHROPIC_PRIMARY_FIXTURE;
  else process.env.ANTHROPIC_PRIMARY_FIXTURE = previousPrimary;
  if (previousSecondary === undefined) delete process.env.ANTHROPIC_SECONDARY_FIXTURE;
  else process.env.ANTHROPIC_SECONDARY_FIXTURE = previousSecondary;
  rmSync(home, { recursive: true, force: true });
});

async function startCountTokensUpstream(): Promise<{
  port: number;
  calls: Array<{ key: string | undefined; model: string; path: string }>;
  close: () => Promise<void>;
}> {
  const calls: Array<{ key: string | undefined; model: string; path: string }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
    const key = request.headers['x-api-key'];
    calls.push({ key: Array.isArray(key) ? key[0] : key, model: body.model, path: request.url ?? '' });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ input_tokens: 42 }));
  });
  const port = await listen(server);
  return {
    port, calls,
    close: async () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function countTokens(port: number, proxyToken: string, model: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({ model, max_tokens: 30, messages: [{ role: 'user', content: 'count this' }] });
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages/count_tokens', method: 'POST', headers: {
      Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

it('counts tokens with the selected Anthropic account and upstream model ID', async () => {
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
    authType: 'api', authRef: 'env:ANTHROPIC_PRIMARY_FIXTURE',
    api: { npm: '@ai-sdk/anthropic' }, addedAt: '2026-11-02',
    accounts: [
      { id: 'primary', authRef: 'env:ANTHROPIC_PRIMARY_FIXTURE', enabled: true },
      { id: 'secondary', authRef: 'env:ANTHROPIC_SECONDARY_FIXTURE', enabled: true },
    ],
  }] });
  const upstream = await startCountTokensUpstream();
  const route: ProxyRoute = {
    aliasId: 'leverframe:anthropic-api:claude-fixture@secondary', realModelId: 'claude-provider-model',
    displayName: 'Claude fixture [HOME]', upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    apiKey: 'primary-route-snapshot', modelFormat: 'anthropic', npm: '@ai-sdk/anthropic',
    providerId: 'anthropic-api', authType: 'api', accountId: 'secondary',
  };
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const response = await countTokens(proxy.port, proxy.token, route.aliasId);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ input_tokens: 42 });
    expect(upstream.calls).toEqual([{
      key: 'secondary-api-key', model: 'claude-provider-model', path: '/v1/messages/count_tokens',
    }]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
