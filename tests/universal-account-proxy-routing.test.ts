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
const previousPrimary = process.env.KIMI_PRIMARY_FIXTURE;
const previousSecondary = process.env.KIMI_SECONDARY_FIXTURE;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-proxy-routing-'));
  process.env.LEVERFRAME_HOME = home;
  process.env.KIMI_PRIMARY_FIXTURE = 'primary-api-key';
  process.env.KIMI_SECONDARY_FIXTURE = 'secondary-api-key';
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: false });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousPrimary === undefined) delete process.env.KIMI_PRIMARY_FIXTURE;
  else process.env.KIMI_PRIMARY_FIXTURE = previousPrimary;
  if (previousSecondary === undefined) delete process.env.KIMI_SECONDARY_FIXTURE;
  else process.env.KIMI_SECONDARY_FIXTURE = previousSecondary;
  rmSync(home, { recursive: true, force: true });
});

async function startCompatibleUpstream(): Promise<{
  port: number;
  calls: Array<{ authorization: string | undefined; model: string }>;
  close: () => Promise<void>;
}> {
  const calls: Array<{ authorization: string | undefined; model: string }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
    const authorization = request.headers.authorization;
    calls.push({ authorization: typeof authorization === 'string' ? authorization : undefined, model: body.model });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chat-completion-fixture', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'selected account response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }));
  });
  const port = await listen(server);
  return {
    port, calls,
    close: async () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

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

it('routes a compatible API request through the selected account credential', async () => {
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'kimi', templateId: 'kimi', name: 'Kimi', enabled: true, authType: 'api',
    authRef: 'env:KIMI_PRIMARY_FIXTURE', api: {}, addedAt: '2026-11-02',
    accounts: [
      { id: 'primary', authRef: 'env:KIMI_PRIMARY_FIXTURE', enabled: true },
      { id: 'secondary', authRef: 'env:KIMI_SECONDARY_FIXTURE', enabled: true },
    ],
  }] });
  const upstream = await startCompatibleUpstream();
  const route: ProxyRoute = {
    aliasId: 'leverframe:kimi:fixture-model@secondary', realModelId: 'fixture-model',
    displayName: 'Fixture model (Kimi)', upstreamUrl: '', apiKey: 'route-snapshot-key',
    modelFormat: 'openai', npm: '@ai-sdk/openai-compatible', providerId: 'kimi', authType: 'api',
    baseURL: `http://127.0.0.1:${upstream.port}/v1`, accountId: 'secondary',
  };
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const response = await postMessages(proxy.port, proxy.token, route.aliasId);

    expect(response.status).toBe(200);
    expect(response.body).toContain('selected account response');
    expect(upstream.calls).toEqual([{ authorization: 'Bearer secondary-api-key', model: 'fixture-model' }]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
