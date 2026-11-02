import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { startServer } from '../src/server/router.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { saveRegistry } from '../src/registry/io.js';
import {
  forwardSdkFetchToLocal,
  messageResponse,
  openAiSuccessResponse,
  quotaResponse,
  startNativeUpstream,
  startOpenAiUpstream,
} from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let previousAlpha: string | undefined;
let previousBeta: string | undefined;
let fakeKeyring: Map<string, string>;

const oauthAlphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000001';

function saveApiAccounts(): void {
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', enabled: true },
        { id: 'beta', authRef: 'env:ACCOUNT_BETA_FIXTURE', enabled: true },
      ],
    }],
  });
}

function saveOAuthAccounts(): void {
  const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000002';
  const oauthCredential = (access: string, accountId: string) => JSON.stringify({
    type: 'oauth', access, refresh: 'unused-refresh-fixture', expires: Date.now() + 3_600_000, accountId,
  });
  fakeKeyring.set(oauthAlphaRef.slice('keyring:'.length), oauthCredential('oauth-alpha-access', 'oauth-alpha-account'));
  fakeKeyring.set(betaRef.slice('keyring:'.length), oauthCredential('oauth-beta-access', 'oauth-beta-account'));
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'openai-oauth', templateId: 'openai-oauth', name: 'ChatGPT OAuth', enabled: true,
      authType: 'oauth', authRef: oauthAlphaRef, api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: oauthAlphaRef, enabled: true },
        { id: 'beta', authRef: betaRef, enabled: true },
      ],
    }],
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-server-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousAlpha = process.env.ACCOUNT_ALPHA_FIXTURE;
  previousBeta = process.env.ACCOUNT_BETA_FIXTURE;
  fakeKeyring = new Map();
  process.env.LEVERFRAME_HOME = home;
  process.env.ACCOUNT_ALPHA_FIXTURE = 'alpha-local-credential';
  process.env.ACCOUNT_BETA_FIXTURE = 'beta-local-credential';
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    }
    if (input.operation === 'write') fakeKeyring.set(input.account, input.value);
    if (input.operation === 'delete') fakeKeyring.delete(input.account);
    return { ok: true, value: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousAlpha === undefined) delete process.env.ACCOUNT_ALPHA_FIXTURE;
  else process.env.ACCOUNT_ALPHA_FIXTURE = previousAlpha;
  if (previousBeta === undefined) delete process.env.ACCOUNT_BETA_FIXTURE;
  else process.env.ACCOUNT_BETA_FIXTURE = previousBeta;
  rmSync(home, { recursive: true, force: true });
});

it('fails over the server native Anthropic route to a configured alternate account', async () => {
  saveApiAccounts();
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'alpha-local-credential') quotaResponse(response);
    else messageResponse(response);
  });
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-key', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'claude-native-fixture', name: 'Native fixture model', isFree: false,
      brand: 'Anthropic', sourceBackend: 'fixture', modelFormat: 'anthropic',
      providerId: 'anthropic-api', authType: 'api', apiKey: 'server-route-snapshot-credential',
      baseUrl: `http://127.0.0.1:${upstream.port}`,
    }]),
  });

  try {
    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-native-fixture', max_tokens: 20,
        messages: [{ role: 'user', content: 'server fixture request' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: [{ text: 'alternate account response' }] });
    expect(upstream.calls).toEqual([
      { key: 'alpha-local-credential', model: 'claude-native-fixture' },
      { key: 'beta-local-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    await server.close();
    await upstream.close();
  }
});

it('records request audit metadata for a successful pooled native server request', async () => {
  saveApiAccounts();
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'alpha-local-credential') quotaResponse(response);
    else messageResponse(response);
  });
  const inferenceLogPath = join(home, 'pooled-native-audit.jsonl');
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-key', serverPassword: null,
    inferenceLogPath,
    catalog: createGatewayModelCatalog([{
      id: 'claude-native-fixture', name: 'Native fixture model', isFree: false,
      brand: 'Anthropic', sourceBackend: 'fixture', modelFormat: 'anthropic',
      providerId: 'anthropic-api', authType: 'api', apiKey: 'server-route-snapshot-credential',
      baseUrl: `http://127.0.0.1:${upstream.port}`,
    }]),
  });

  try {
    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-native-fixture', max_tokens: 20,
        messages: [{ role: 'user', content: 'audit fixture request' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: [{ text: 'alternate account response' }] });
    expect(upstream.calls).toHaveLength(2);
    const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(entries).toContainEqual(expect.objectContaining({
      modelId: 'claude-native-fixture', provider: 'anthropic-api', route: 'passthrough',
    }));
  } finally {
    await server.close();
    await upstream.close();
  }
});

it('fails over the server translated ChatGPT OAuth route with resolved account metadata', async () => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream((call, response) => {
    if (call.authorization === 'Bearer oauth-alpha-access') {
      response.writeHead(429, {
        'Content-Type': 'application/json',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
      });
      response.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'limit reached' } }));
      return;
    }
    openAiSuccessResponse(response);
  });
  const gatewayFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-key', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'gpt-4o-mini', name: 'ChatGPT OAuth fixture', isFree: false,
      brand: 'OpenAI', sourceBackend: 'fixture', modelFormat: 'openai',
      providerId: 'openai-oauth', authType: 'oauth', npm: '@ai-sdk/openai',
      apiKey: 'server-route-snapshot-token', preferWebSockets: false,
    }]),
  });

  try {
    const response = await gatewayFetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 20, messages: [{ role: 'user', content: 'fixture' }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('OAuth fixture response');
    expect(upstream.calls).toEqual([
      {
        authorization: 'Bearer oauth-alpha-access', accountId: 'oauth-alpha-account',
        model: 'gpt-4o-mini', path: expect.stringContaining('/responses'),
      },
      {
        authorization: 'Bearer oauth-beta-access', accountId: 'oauth-beta-account',
        model: 'gpt-4o-mini', path: expect.stringContaining('/responses'),
      },
    ]);
  } finally {
    await server.close();
    await upstream.close();
  }
});

it('preserves execution identity headers when the server OAuth pool is exhausted', async () => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream((_call, response) => {
    response.writeHead(429, {
      'Content-Type': 'application/json',
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
    });
    response.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'limit reached' } }));
  });
  const gatewayFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-key', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'gpt-4o-mini', name: 'ChatGPT OAuth fixture', isFree: false,
      brand: 'OpenAI', sourceBackend: 'fixture', modelFormat: 'openai',
      providerId: 'openai-oauth', authType: 'oauth', npm: '@ai-sdk/openai',
      apiKey: 'server-route-snapshot-token', preferWebSockets: false,
    }]),
  });

  try {
    const response = await gatewayFetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 20, messages: [{ role: 'user', content: 'fixture' }] }),
    });

    expect(response.status).toBe(429);
    expect((await response.text()).toLowerCase()).toContain('pool exhausted');
    expect(response.headers.get('x-leverframe-execution-id')).toBeTruthy();
    expect(response.headers.get('x-leverframe-generation')).toBeTruthy();
    expect(upstream.calls).toHaveLength(2);
  } finally {
    await server.close();
    await upstream.close();
  }
});

it('does not fail over a server translated OAuth request for an unclassified 429', async () => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream((_call, response) => {
    response.writeHead(429, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'server_error', message: 'unclassified rejection' } }));
  });
  const gatewayFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-key', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'gpt-4o-mini', name: 'ChatGPT OAuth fixture', isFree: false,
      brand: 'OpenAI', sourceBackend: 'fixture', modelFormat: 'openai',
      providerId: 'openai-oauth', authType: 'oauth', npm: '@ai-sdk/openai',
      apiKey: 'server-route-snapshot-token', preferWebSockets: false,
    }]),
  });

  try {
    await gatewayFetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 20, messages: [{ role: 'user', content: 'fixture' }] }),
    });

    expect(upstream.calls).toEqual([{
      authorization: 'Bearer oauth-alpha-access', accountId: 'oauth-alpha-account',
      model: 'gpt-4o-mini', path: expect.stringContaining('/responses'),
    }]);
  } finally {
    await server.close();
    await upstream.close();
  }
});

it('does not replay a server OAuth stream after partial output reaches the client', async () => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream((_call, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    response.write([
      'data: {"type":"response.created","response":{"id":"partial-server-response","created_at":1,"model":"gpt-4o-mini"}}',
      '',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"partial-server-message"}}',
      '',
      'data: {"type":"response.output_text.delta","item_id":"partial-server-message","delta":"partial server text"}',
      '',
      '',
    ].join('\n'));
    setTimeout(() => response.destroy(), 20);
  });
  const gatewayFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-key', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'gpt-4o-mini', name: 'ChatGPT OAuth fixture', isFree: false,
      brand: 'OpenAI', sourceBackend: 'fixture', modelFormat: 'openai',
      providerId: 'openai-oauth', authType: 'oauth', npm: '@ai-sdk/openai',
      apiKey: 'server-route-snapshot-token', preferWebSockets: false,
    }]),
  });

  try {
    const response = await gatewayFetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 20,
        messages: [{ role: 'user', content: 'fixture' }], stream: true,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('partial server text');
    expect(upstream.calls).toHaveLength(1);
  } finally {
    await server.close();
    await upstream.close();
  }
}, 15_000);

it('logs usage from a successful pooled server OAuth stream', async () => {
  saveOAuthAccounts();
  const upstream = await startOpenAiUpstream((_call, response) => openAiSuccessResponse(response));
  const gatewayFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const inferenceLogPath = join(home, 'server-inference.jsonl');
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-key', serverPassword: null,
    inferenceLogPath,
    catalog: createGatewayModelCatalog([{
      id: 'gpt-4o-mini', name: 'ChatGPT OAuth fixture', isFree: false,
      brand: 'OpenAI', sourceBackend: 'fixture', modelFormat: 'openai',
      providerId: 'openai-oauth', authType: 'oauth', npm: '@ai-sdk/openai',
      apiKey: 'server-route-snapshot-token', preferWebSockets: false,
    }]),
  });

  try {
    const response = await gatewayFetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 20,
        messages: [{ role: 'user', content: 'fixture' }], stream: true,
      }),
    });
    const body = await response.text();
    const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(body).toContain('OAuth fixture response');
    expect(response.headers.get('x-leverframe-execution-id')).toBeTruthy();
    expect(response.headers.get('x-leverframe-generation')).toBeTruthy();
    expect(entries).toContainEqual(expect.objectContaining({
      event: 'response_usage', usageStage: 'message_delta', inputTokens: 4, outputTokens: 3,
    }));
  } finally {
    await server.close();
    await upstream.close();
  }
});

it('refuses route snapshot fallback after a server provider is removed', async () => {
  saveApiAccounts();
  const upstream = await startNativeUpstream((_call, response) => messageResponse(response));
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-key', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'claude-native-fixture', name: 'Native fixture model', isFree: false,
      brand: 'Anthropic', sourceBackend: 'fixture', modelFormat: 'anthropic',
      providerId: 'anthropic-api', authType: 'api', apiKey: 'server-route-snapshot-credential',
      baseUrl: `http://127.0.0.1:${upstream.port}`,
    }]),
  });

  try {
    const first = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native-fixture', max_tokens: 20, messages: [{ role: 'user', content: 'fixture' }] }),
    });
    saveRegistry({ schemaVersion: 1, providers: [] });
    const afterRemoval = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native-fixture', max_tokens: 20, messages: [{ role: 'user', content: 'fixture' }] }),
    });
    const errorBody = await afterRemoval.text();

    expect(first.status).toBe(200);
    expect(afterRemoval.status).toBe(429);
    expect(errorBody.toLowerCase()).toContain('pool');
    expect(errorBody).not.toContain('server-route-snapshot-credential');
    expect(upstream.calls).toEqual([
      { key: 'alpha-local-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    await server.close();
    await upstream.close();
  }
});
