import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { savePreferences } from '../src/config.js';
import { recordObservation, type PoolKey } from '../src/account-pool.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { saveRegistry } from '../src/registry/io.js';
import {
  forwardSdkFetchToLocal, messageResponse, openAiSuccessResponse, quotaResponse,
  startNativeUpstream, startOpenAiUpstream,
} from './fixtures/account-pool-proxy.js';

const alphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000031';
const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000032';
const apiAlphaRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174110';
const apiBetaRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174111';
const gatewayToken = 'fixture-openai-gateway-sentinel';
const catalogToken = 'route-catalog-token-must-not-be-used';

let home: string;
let previousHome: string | undefined;
let previousHeartbeat: string | undefined;
let fakeKeyring: Map<string, string>;
let server: ServerHandle | undefined;

function saveOAuthAccounts(accountState = { alphaEnabled: true, betaEnabled: true }): void {
  const credential = (access: string, accountId: string) => JSON.stringify({
    type: 'oauth', access, refresh: 'unused-refresh-fixture', expires: Date.now() + 3_600_000, accountId,
  });
  fakeKeyring.set(alphaRef.slice('keyring:'.length), credential('oauth-alpha-access', 'oauth-alpha-account'));
  fakeKeyring.set(betaRef.slice('keyring:'.length), credential('oauth-beta-access', 'oauth-beta-account'));
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'openai-oauth', templateId: 'openai-oauth', name: 'ChatGPT OAuth', enabled: true,
      authType: 'oauth', authRef: alphaRef, api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: alphaRef, enabled: accountState.alphaEnabled },
        { id: 'beta', authRef: betaRef, enabled: accountState.betaEnabled },
      ],
    }],
  });
}

function saveOnlyBetaAccount(): void {
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'openai-oauth', templateId: 'openai-oauth', name: 'ChatGPT OAuth', enabled: true,
      authType: 'oauth', authRef: alphaRef, api: {}, addedAt: '2026-01-01',
      accounts: [{ id: 'beta', authRef: betaRef, enabled: true }],
    }],
  });
}

function saveAnthropicApiAccounts(): void {
  fakeKeyring.set(apiAlphaRef.slice('keyring:'.length), 'anthropic-alpha-api-sentinel');
  fakeKeyring.set(apiBetaRef.slice('keyring:'.length), 'anthropic-beta-api-sentinel');
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API fixture', enabled: true,
      authType: 'api', authRef: apiAlphaRef, api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: apiAlphaRef, enabled: true },
        { id: 'beta', authRef: apiBetaRef, enabled: true },
      ],
    }],
  });
}

function openAiCatalog() {
  return createGatewayModelCatalog([{
    id: 'gpt-pool-fixture', name: 'OAuth pool fixture', isFree: false, brand: 'OpenAI',
    sourceBackend: 'fixture', modelFormat: 'openai', providerId: 'openai-oauth',
    authType: 'oauth', npm: '@ai-sdk/openai', apiKey: catalogToken, preferWebSockets: false,
  }]);
}

function partialOpenAiStream(response: import('node:http').ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: {"type":"response.created","response":{"id":"partial-fixture","created_at":1,"model":"gpt-pool-fixture"}}\n\n');
  response.write('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"partial-message"}}\n\n');
  response.write('data: {"type":"response.output_text.delta","item_id":"partial-message","delta":"visible partial output"}\n\n');
  setTimeout(() => response.destroy(), 20);
}

async function startPublicOpenAiServer(): Promise<ServerHandle> {
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: gatewayToken, serverPassword: null, catalog: openAiCatalog(),
  });
  return server;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-openai-public-pool-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousHeartbeat = process.env.LEVERFRAME_SSE_HEARTBEAT_MS;
  process.env.LEVERFRAME_HOME = home;
  fakeKeyring = new Map();
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    }
    if (input.operation === 'write') fakeKeyring.set(input.account, input.value);
    if (input.operation === 'delete') fakeKeyring.delete(input.account);
    return { ok: true, value: null };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousHeartbeat === undefined) delete process.env.LEVERFRAME_SSE_HEARTBEAT_MS;
  else process.env.LEVERFRAME_SSE_HEARTBEAT_MS = previousHeartbeat;
  rmSync(home, { recursive: true, force: true });
});

it.each([false, true])('uses the configured OAuth pool on public OpenAI route (stream=%s)', async stream => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream((call, response) => {
    if (call.authorization === 'Bearer oauth-alpha-access') {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'fixture quota' } }));
      return;
    }
    openAiSuccessResponse(response);
  });
  const upstreamFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = await startPublicOpenAiServer();

  try {
    const response = await upstreamFetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-pool-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }], stream,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('OAuth fixture response');
    expect(upstream.calls).toEqual([
      {
        authorization: 'Bearer oauth-alpha-access', accountId: 'oauth-alpha-account',
        model: 'gpt-pool-fixture', path: expect.stringContaining('/responses'),
      },
      {
        authorization: 'Bearer oauth-beta-access', accountId: 'oauth-beta-account',
        model: 'gpt-pool-fixture', path: expect.stringContaining('/responses'),
      },
    ]);
  } finally {
    await upstream.close();
  }
});

it('uses one configured OAuth account and does not fail over when failover is disabled', async () => {
  saveOAuthAccounts();
  savePreferences({ accountPoolFailover: false });
  const upstream = await startOpenAiUpstream((call, response) => {
    if (call.authorization === 'Bearer oauth-alpha-access') {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'fixture quota' } }));
      return;
    }
    openAiSuccessResponse(response);
  });
  const upstreamFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = await startPublicOpenAiServer();

  try {
    const response = await upstreamFetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-pool-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }] }),
    });

    expect(response.status).toBe(429);
    expect(upstream.calls).toEqual([{
      authorization: 'Bearer oauth-alpha-access', accountId: 'oauth-alpha-account',
      model: 'gpt-pool-fixture', path: expect.stringContaining('/responses'),
    }]);
  } finally {
    await upstream.close();
  }
});

it('does not fall back to the catalog credential after every configured account is disabled', async () => {
  saveOAuthAccounts({ alphaEnabled: false, betaEnabled: false });
  const upstream = await startOpenAiUpstream();
  const upstreamFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = await startPublicOpenAiServer();

  try {
    const response = await upstreamFetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-pool-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }] }),
    });

    expect(response.status).not.toBe(200);
    expect(upstream.calls).toEqual([]);
  } finally {
    await upstream.close();
  }
});

it('moves a public OpenAI session to a verified higher-capacity OAuth account', async () => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream();
  const upstreamFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = await startPublicOpenAiServer();
  const session = '11111111-1111-4111-8111-111111111111';
  const pool: PoolKey = { providerId: 'openai-oauth', modelId: 'gpt-pool-fixture', billingType: 'oauth' };

  try {
    const send = () => upstreamFetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session },
      body: JSON.stringify({ model: 'gpt-pool-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }] }),
    });
    const initial = await send();
    expect(initial.status).toBe(200);
    await initial.text();
    const observedAt = Date.now();
    await recordObservation({ pool, now: observedAt, observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'codex:event', observedAt,
      status: 'healthy', dimension: 'codex:weekly:secondary:10080',
      remaining: { value: 5, limit: 100, unit: 'codex:weekly:secondary:10080' },
    } });
    await recordObservation({ pool, now: observedAt, observation: {
      accountId: 'beta', scope: { kind: 'pool' }, source: 'codex:event', observedAt,
      status: 'healthy', dimension: 'codex:weekly:secondary:10080',
      remaining: { value: 70, limit: 100, unit: 'codex:weekly:secondary:10080' },
    } });

    const switched = await send();
    expect(switched.status).toBe(200);
    await switched.text();
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await upstream.close();
  }
});

it('reselects a remaining account when the active public OpenAI OAuth account is removed', async () => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream();
  const upstreamFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = await startPublicOpenAiServer();
  const session = '22222222-2222-4222-8222-222222222222';

  try {
    const send = () => upstreamFetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session },
      body: JSON.stringify({ model: 'gpt-pool-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }] }),
    });
    const first = await send();
    expect(first.status).toBe(200);
    await first.text();
    saveOnlyBetaAccount();

    const next = await send();
    expect(next.status).toBe(200);
    await next.text();
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await upstream.close();
  }
});

it('uses the configured Anthropic API account pool for the public OpenAI translated route', async () => {
  saveAnthropicApiAccounts();
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'anthropic-alpha-api-sentinel') quotaResponse(response);
    else messageResponse(response);
  });
  const route = await startServer({
    host: '127.0.0.1', port: 0, apiKey: gatewayToken, serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'anthropic-api-pool-fixture', name: 'Anthropic API pool fixture', isFree: false,
      brand: 'Anthropic', sourceBackend: 'fixture', modelFormat: 'anthropic',
      providerId: 'anthropic-api', authType: 'api', npm: '@ai-sdk/anthropic',
      apiKey: catalogToken, baseUrl: `http://127.0.0.1:${upstream.port}`,
    }]),
  });
  server = route;

  try {
    const response = await fetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic-api-pool-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }] }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('alternate account response');
    expect(upstream.calls).toEqual([
      { key: 'anthropic-alpha-api-sentinel', model: 'anthropic-api-pool-fixture' },
      { key: 'anthropic-beta-api-sentinel', model: 'anthropic-api-pool-fixture' },
    ]);
  } finally {
    await route.close();
    server = undefined;
    await upstream.close();
  }
});

it('uses the configured Anthropic API account pool for the public OpenAI native relay branch', async () => {
  saveAnthropicApiAccounts();
  const upstream = await startOpenAiUpstream((call, response) => {
    if (call.authorization === 'Bearer anthropic-alpha-api-sentinel') {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'fixture quota' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-fixture', object: 'chat.completion', model: call.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'direct fixture response' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  const route = await startServer({
    host: '127.0.0.1', port: 0, apiKey: gatewayToken, serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'anthropic-api-direct-fixture', name: 'Anthropic API direct fixture', isFree: false,
      brand: 'Anthropic', sourceBackend: 'fixture', modelFormat: 'openai',
      providerId: 'anthropic-api', authType: 'api', apiKey: catalogToken,
      completionsUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
    }]),
  });
  server = route;

  try {
    const response = await fetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic-api-direct-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }] }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('direct fixture response');
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer anthropic-alpha-api-sentinel', 'Bearer anthropic-beta-api-sentinel',
    ]);
  } finally {
    await route.close();
    server = undefined;
    await upstream.close();
  }
});

it('does not replay an Anthropic API direct-relay stream after visible output', async () => {
  saveAnthropicApiAccounts();
  const upstream = await startOpenAiUpstream((_call, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
    response.write('data: {"choices":[{"index":0,"delta":{"content":"visible direct partial"},"finish_reason":null}]}\n\n');
    setTimeout(() => response.destroy(), 20);
  });
  const route = await startServer({
    host: '127.0.0.1', port: 0, apiKey: gatewayToken, serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'anthropic-api-direct-fixture', name: 'Anthropic API direct fixture', isFree: false,
      brand: 'Anthropic', sourceBackend: 'fixture', modelFormat: 'openai',
      providerId: 'anthropic-api', authType: 'api', apiKey: catalogToken,
      completionsUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
    }]),
  });
  server = route;

  try {
    const response = await fetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-api-direct-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }], stream: true,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('visible direct partial');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.authorization).toBe('Bearer anthropic-alpha-api-sentinel');
  } finally {
    await route.close();
    server = undefined;
    await upstream.close();
  }
});

it('does not retry a public OpenAI stream after a heartbeat is visible to the client', async () => {
  saveOAuthAccounts();
  savePreferences({ accountPoolFailover: true });
  process.env.LEVERFRAME_SSE_HEARTBEAT_MS = '1';
  const upstream = await startOpenAiUpstream((call, response) => {
    const reject = () => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'fixture quota' } }));
    };
    setTimeout(reject, 25);
  });
  const upstreamFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = await startPublicOpenAiServer();

  try {
    const response = await upstreamFetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-pool-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }], stream: true }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: ping');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.authorization).toBe('Bearer oauth-alpha-access');
  } finally {
    await upstream.close();
  }
});

it('does not retry a public OpenAI stream after partial output reaches the client', async () => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream((_call, response) => partialOpenAiStream(response));
  const upstreamFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = await startPublicOpenAiServer();

  try {
    const response = await upstreamFetch(`${route.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-pool-fixture', messages: [{ role: 'user', content: 'offline pool fixture' }], stream: true }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('visible partial output');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.authorization).toBe('Bearer oauth-alpha-access');
  } finally {
    await upstream.close();
  }
});
