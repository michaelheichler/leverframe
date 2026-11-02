import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { savePreferences } from '../src/config.js';
import { loadRegistry } from '../src/registry/io.js';
import { formatProviderAccounts } from '../src/account-management.js';
import { readLatestPoolActivity } from '../src/account-pool-activity.js';
import { saveRegistry } from '../src/registry/io.js';
import {
  forwardSdkFetchToLocal,
  openAiSuccessResponse,
  startOpenAiUpstream,
} from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let previousHeartbeat: string | undefined;
let fakeKeyring: Map<string, string>;

const oauthAlphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000001';

function saveChatGptOAuthProvider(pinnedAccountId?: string): void {
  const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000002';
  const credential = (access: string, accountId: string) => JSON.stringify({
    type: 'oauth', access, refresh: 'unused-refresh-fixture', expires: Date.now() + 3_600_000, accountId,
  });
  fakeKeyring.set(oauthAlphaRef.slice('keyring:'.length), credential('oauth-alpha-access', 'oauth-alpha-account'));
  fakeKeyring.set(betaRef.slice('keyring:'.length), credential('oauth-beta-access', 'oauth-beta-account'));
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'openai-oauth', templateId: 'openai-oauth', name: 'ChatGPT OAuth', enabled: true,
      authType: 'oauth', authRef: oauthAlphaRef, api: {}, addedAt: '2026-01-01',
      ...(pinnedAccountId ? { pinnedAccountId } : {}),
      accounts: [
        { id: 'alpha', authRef: oauthAlphaRef, enabled: true },
        { id: 'beta', authRef: betaRef, enabled: true },
      ],
    }],
  });
}

function chatGptRoute(): ProxyRoute {
  return {
    aliasId: 'openai-oauth__gpt-4o-mini', realModelId: 'gpt-4o-mini',
    displayName: 'ChatGPT OAuth fixture', upstreamUrl: '', apiKey: 'route-snapshot-oauth-token',
    modelFormat: 'openai', npm: '@ai-sdk/openai', providerId: 'openai-oauth', authType: 'oauth',
    preferWebSockets: false,
  };
}

function postMessages(
  port: number,
  token: string,
  model: string,
  stream = false,
  sessionId?: string,
  relayRequestId?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }], stream,
    });
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(sessionId ? { 'X-Claude-Code-Session-Id': sessionId } : {}),
        ...(relayRequestId ? { 'x-relay-request-id': relayRequestId } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers,
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function postStreamUntilHeartbeat(port: number, token: string, model: string): Promise<{
  status: number;
  chunks: string[];
  chunkCountAtClose: number;
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }], stream: true,
    });
    const chunks: string[] = [];
    let status = 0;
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, response => {
      status = response.statusCode ?? 0;
      response.on('data', chunk => {
        chunks.push(Buffer.from(chunk).toString('utf8'));
        if (chunks.join('').includes('event: ping')) response.destroy();
      });
      response.on('close', () => resolve({ status, chunks, chunkCountAtClose: chunks.length }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-oauth-proxy-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousHeartbeat = process.env.LEVERFRAME_SSE_HEARTBEAT_MS;
  fakeKeyring = new Map();
  process.env.LEVERFRAME_HOME = home;
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
  if (previousHeartbeat === undefined) delete process.env.LEVERFRAME_SSE_HEARTBEAT_MS;
  else process.env.LEVERFRAME_SSE_HEARTBEAT_MS = previousHeartbeat;
  rmSync(home, { recursive: true, force: true });
});

it('fails over translated ChatGPT OAuth through the SDK with each account identity', async () => {
  saveChatGptOAuthProvider();
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
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const response = await postMessages(proxy.port, proxy.token, route.aliasId);

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
    expect(response.status, response.body).toBe(200);
    expect(response.body).toContain('OAuth fixture response');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('preserves execution identity headers when every pooled OAuth account is exhausted', async () => {
  saveChatGptOAuthProvider();
  const upstream = await startOpenAiUpstream((_call, response) => {
    response.writeHead(429, {
      'Content-Type': 'application/json',
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
    });
    response.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'limit reached' } }));
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const response = await postMessages(proxy.port, proxy.token, route.aliasId);

    expect(response.status).toBe(429);
    expect(response.body.toLowerCase()).toContain('pool exhausted');
    expect(response.headers['x-leverframe-execution-id']).toBeTruthy();
    expect(response.headers['x-leverframe-generation']).toBeTruthy();
    expect(upstream.calls).toHaveLength(2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('keeps an exhausted Codex secondary window despite healthy primary telemetry', async () => {
  saveChatGptOAuthProvider();
  const resetAt = String(Math.floor(Date.now() / 1000) + 3600);
  const upstream = await startOpenAiUpstream((call, response) => {
    if (call.authorization === 'Bearer oauth-alpha-access') {
      openAiSuccessResponse(response, {
        'x-codex-primary-used-percent': '5',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': resetAt,
        'x-codex-secondary-used-percent': '100',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': resetAt,
      });
      return;
    }
    openAiSuccessResponse(response, {
      'x-codex-primary-used-percent': '50',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': resetAt,
      'x-codex-secondary-used-percent': '50',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': resetAt,
    });
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const first = await postMessages(proxy.port, proxy.token, route.aliasId);
    const second = await postMessages(proxy.port, proxy.token, route.aliasId);
    const third = await postMessages(proxy.port, proxy.token, route.aliasId);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('retains exhausted windows reported under a dynamic Codex header prefix', async () => {
  saveChatGptOAuthProvider();
  const resetAt = String(Math.floor(Date.now() / 1000) + 3600);
  const upstream = await startOpenAiUpstream((call, response) => {
    const alpha = call.authorization === 'Bearer oauth-alpha-access';
    openAiSuccessResponse(response, {
      'x-codex-extra-primary-used-percent': alpha ? '5' : '50',
      'x-codex-extra-primary-window-minutes': '300',
      'x-codex-extra-primary-reset-at': resetAt,
      'x-codex-extra-secondary-used-percent': alpha ? '100' : '50',
      'x-codex-extra-secondary-window-minutes': '10080',
      'x-codex-extra-secondary-reset-at': resetAt,
    });
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    await postMessages(proxy.port, proxy.token, route.aliasId);
    await postMessages(proxy.port, proxy.token, route.aliasId);
    await postMessages(proxy.port, proxy.token, route.aliasId);

    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('uses Codex rate-limit events when selecting after a successful OAuth response', async () => {
  saveChatGptOAuthProvider();
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const upstream = await startOpenAiUpstream((call, response) => {
    const alpha = call.authorization === 'Bearer oauth-alpha-access';
    openAiSuccessResponse(response, {}, [{
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: alpha ? 5 : 50, window_minutes: 300, reset_at: resetAt },
        secondary: { used_percent: alpha ? 100 : 50, window_minutes: 10080, reset_at: resetAt },
      },
      metered_limit_name: 'fixture subscription',
    }]);
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    await postMessages(proxy.port, proxy.token, route.aliasId);
    await postMessages(proxy.port, proxy.token, route.aliasId);
    await postMessages(proxy.port, proxy.token, route.aliasId);

    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('does not replay a translated OAuth request after the upstream stream emits partial content', async () => {
  saveChatGptOAuthProvider();
  const upstream = await startOpenAiUpstream((_call, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    response.write([
      'data: {"type":"response.created","response":{"id":"partial-response","created_at":1,"model":"gpt-4o-mini"}}',
      '',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"partial-message"}}',
      '',
      'data: {"type":"response.output_text.delta","item_id":"partial-message","delta":"partial text"}',
      '',
      '',
    ].join('\n'));
    setTimeout(() => response.destroy(), 20);
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const response = await postMessages(proxy.port, proxy.token, route.aliasId, true);

    expect(response.status).toBe(200);
    expect(response.body).toContain('partial text');
    expect(upstream.calls).toHaveLength(1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
}, 15_000);

it('updates OAuth account metadata for new requests without disrupting an active stream', async () => {
  saveChatGptOAuthProvider('alpha');
  savePreferences({ accountPoolBalancing: false });
  let releaseFirstResponse = () => {};
  let signalFirstRequest = () => {};
  let first = true;
  const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const firstRequestSeen = new Promise<void>(resolve => { signalFirstRequest = resolve; });
  const upstream = await startOpenAiUpstream(async (_call, response) => {
    if (first) {
      first = false;
      signalFirstRequest();
      await firstResponseGate;
    }
    openAiSuccessResponse(response);
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const originalStream = postMessages(proxy.port, proxy.token, route.aliasId, true);
    await firstRequestSeen;
    fakeKeyring.set(oauthAlphaRef.slice('keyring:'.length), JSON.stringify({
      type: 'oauth', access: 'oauth-alpha-refreshed-access', refresh: 'unused-refresh-fixture',
      expires: Date.now() + 3_600_000, accountId: 'oauth-alpha-refreshed-account',
    }));
    const refreshedRequest = await postMessages(proxy.port, proxy.token, route.aliasId);
    releaseFirstResponse();
    const originalResponse = await originalStream;

    expect([originalResponse.status, refreshedRequest.status]).toEqual([200, 200]);
    expect(originalResponse.body).toContain('OAuth fixture response');
    expect(refreshedRequest.body).toContain('OAuth fixture response');
    expect(upstream.calls.map(call => [call.authorization, call.accountId])).toEqual([
      ['Bearer oauth-alpha-access', 'oauth-alpha-account'],
      ['Bearer oauth-alpha-refreshed-access', 'oauth-alpha-refreshed-account'],
    ]);
  } finally {
    releaseFirstResponse();
    await proxy.close();
    await upstream.close();
  }
}, 15_000);

it('sends a heartbeat during a pooled OAuth stream and stops writing after client disconnect', async () => {
  saveChatGptOAuthProvider();
  process.env.LEVERFRAME_SSE_HEARTBEAT_MS = '10';
  const upstream = await startOpenAiUpstream((_call, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    response.write([
      'data: {"type":"response.created","response":{"id":"heartbeat-response","created_at":1,"model":"gpt-4o-mini"}}',
      '',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"heartbeat-message"}}',
      '',
      'data: {"type":"response.output_text.delta","item_id":"heartbeat-message","delta":"stream is active"}',
      '',
      '',
    ].join('\n'));
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const stream = await postStreamUntilHeartbeat(proxy.port, proxy.token, route.aliasId);
    const output = stream.chunks.join('');
    const chunkCountAtClose = stream.chunkCountAtClose;
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(stream.status).toBe(200);
    expect(output).toContain('stream is active');
    expect(output).toContain('event: ping');
    expect(output.indexOf('event: ping')).toBeGreaterThan(output.indexOf('stream is active'));
    expect(stream.chunks).toHaveLength(chunkCountAtClose);
    expect(upstream.calls).toHaveLength(1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
}, 15_000);

it('does not fail over a translated OAuth request for an unclassified 429', async () => {
  saveChatGptOAuthProvider();
  const upstream = await startOpenAiUpstream((_call, response) => {
    response.writeHead(429, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'server_error', message: 'unclassified rejection' } }));
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    await postMessages(proxy.port, proxy.token, route.aliasId);

    expect(upstream.calls).toEqual([{
      authorization: 'Bearer oauth-alpha-access', accountId: 'oauth-alpha-account',
      model: 'gpt-4o-mini', path: expect.stringContaining('/responses'),
    }]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('shows the latest account switch without exposing credentials or raw session IDs', async () => {
  saveChatGptOAuthProvider();
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
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);
  const sessionId = '11111111-1111-4111-8111-111111111111';

  try {
    const response = await postMessages(proxy.port, proxy.token, route.aliasId, false, sessionId);
    const activity = await readLatestPoolActivity('openai-oauth');
    const provider = loadRegistry().providers.find(item => item.id === 'openai-oauth')!;
    const display = formatProviderAccounts(provider, activity ?? undefined).join('\n');

    expect(response.status).toBe(200);
    expect(activity?.activeAccountId).toBe('beta');
    expect(activity?.switchReason).toBeTruthy();
    expect(display).toContain('beta (enabled, active)');
    expect(display).toContain(activity!.switchReason!);
    expect(display).not.toContain('oauth-alpha-access');
    expect(display).not.toContain('oauth-beta-access');
    expect(display).not.toContain(oauthAlphaRef);
    expect(display).not.toContain(sessionId);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('keeps quota exclusion after the same OAuth credential is rotated', async () => {
  saveChatGptOAuthProvider('alpha');
  savePreferences({ accountPoolBalancing: false });
  const alphaAccountName = oauthAlphaRef.slice('keyring:'.length);
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
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const first = await postMessages(proxy.port, proxy.token, route.aliasId);
    fakeKeyring.set(alphaAccountName, JSON.stringify({
      type: 'oauth', access: 'oauth-alpha-rotated-access', refresh: 'unused-refresh-fixture',
      expires: Date.now() + 3_600_000, accountId: 'oauth-alpha-account',
    }));
    const second = await postMessages(proxy.port, proxy.token, route.aliasId);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-beta-access',
    ]);
    const state = readFileSync(join(home, 'account-pool-state.json'), 'utf8');
    expect(state).not.toContain(alphaAccountName);
    expect(state).not.toContain('oauth-alpha-access');
    expect(state).not.toContain('oauth-alpha-rotated-access');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('logs a successful pooled OAuth translation and returns execution identity headers', async () => {
  saveChatGptOAuthProvider();
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
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const requestId = 'pooled-translation-fixture';
  const inferenceLogPath = join(home, 'inference.jsonl');
  const proxy = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

  try {
    const response = await postMessages(proxy.port, proxy.token, route.aliasId, false, undefined, requestId);
    const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(response.headers['x-leverframe-execution-id']).toBeTruthy();
    expect(response.headers['x-leverframe-generation']).toBeTruthy();
    expect(entries).toContainEqual(expect.objectContaining({ event: 'translation_dispatched', requestId }));
    expect(entries).toContainEqual(expect.objectContaining({ event: 'translation_started', requestId }));
    expect(entries).toContainEqual(expect.objectContaining({ event: 'translation_completed', requestId }));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
