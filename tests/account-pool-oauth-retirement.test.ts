import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { ProviderRuntimeCache } from '../src/provider-runtime-cache.js';
import { saveRegistry } from '../src/registry/io.js';
import { forwardSdkFetchToLocal, openAiSuccessResponse, startOpenAiUpstream } from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let fakeKeyring: Map<string, string>;

const alphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000001';
const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000002';

function saveOAuthAccounts(): void {
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
        { id: 'alpha', authRef: alphaRef, enabled: true },
        { id: 'beta', authRef: betaRef, enabled: true },
      ],
    }],
  });
}

function route(): ProxyRoute {
  return {
    aliasId: 'openai-oauth__gpt-4o-mini', realModelId: 'gpt-4o-mini',
    displayName: 'ChatGPT OAuth fixture', upstreamUrl: '', apiKey: 'route-snapshot-oauth-token',
    modelFormat: 'openai', npm: '@ai-sdk/openai', providerId: 'openai-oauth', authType: 'oauth',
    preferWebSockets: false,
  };
}

function postMessages(port: number, token: string, modelId: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: modelId, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }], stream: false,
    });
    const outgoing = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function startStreamUntilText(port: number, token: string, modelId: string, expectedText: string): {
  firstText: Promise<void>;
  completed: Promise<{ status: number; body: string }>;
} {
  let signalText = () => {};
  let resolveCompleted = (_result: { status: number; body: string }) => {};
  let rejectCompleted = (_error: Error) => {};
  let received = '';
  let sawText = false;
  const firstText = new Promise<void>(resolve => { signalText = resolve; });
  const completed = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const body = JSON.stringify({
    model: modelId, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }], stream: true,
  });
  const outgoing = http.request({
    hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, response => {
    response.on('data', chunk => {
      received += Buffer.from(chunk).toString('utf8');
      if (!sawText && received.includes(expectedText)) {
        sawText = true;
        signalText();
      }
    });
    response.on('end', () => resolveCompleted({ status: response.statusCode ?? 0, body: received }));
    response.on('error', error => rejectCompleted(error));
  });
  outgoing.on('error', error => rejectCompleted(error));
  outgoing.end(body);
  return { firstText, completed };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-oauth-retirement-'));
  previousHome = process.env.LEVERFRAME_HOME;
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
  rmSync(home, { recursive: true, force: true });
});

it('retires a removed OAuth account handle while its active stream can finish', async () => {
  saveOAuthAccounts();
  let releaseAlpha = () => {};
  let firstAlpha = true;
  const alphaGate = new Promise<void>(resolve => { releaseAlpha = resolve; });
  const upstream = await startOpenAiUpstream(async (call, response) => {
    if (call.authorization === 'Bearer oauth-alpha-access' && firstAlpha) {
      firstAlpha = false;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      response.write([
        'data: {"type":"response.created","response":{"id":"retirement-response","created_at":1,"model":"gpt-4o-mini"}}',
        '',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"retirement-message"}}',
        '',
        'data: {"type":"response.output_text.delta","item_id":"retirement-message","delta":"alpha stream remains active"}',
        '',
        '',
      ].join('\n'));
      await alphaGate;
      response.end('data: {"type":"response.completed","response":{"id":"retirement-response","usage":{"input_tokens":4,"output_tokens":3}}}\n\n');
      return;
    }
    openAiSuccessResponse(response);
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const model = route();
  const proxy = await startProxyCatalog([model], model.aliasId, false);
  const forget = vi.spyOn(ProviderRuntimeCache.prototype, 'forget');

  try {
    const alphaStream = startStreamUntilText(proxy.port, proxy.token, model.aliasId, 'alpha stream remains active');
    await alphaStream.firstText;
    saveRegistry({
      schemaVersion: 1,
      providers: [{
        id: 'openai-oauth', templateId: 'openai-oauth', name: 'ChatGPT OAuth', enabled: true,
        authType: 'oauth', authRef: alphaRef, api: {}, addedAt: '2026-01-01',
        accounts: [{ id: 'beta', authRef: betaRef, enabled: true }],
      }],
    });
    const betaResponse = await postMessages(proxy.port, proxy.token, model.aliasId);
    releaseAlpha();
    const alphaResponse = await alphaStream.completed;

    expect(betaResponse.status).toBe(200);
    expect(alphaResponse.status).toBe(200);
    expect(alphaResponse.body).toContain('alpha stream remains active');
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access',
    ]);
    expect(forget).toHaveBeenCalled();
  } finally {
    releaseAlpha();
    await proxy.close();
    await upstream.close();
  }
}, 15_000);

it('retires OAuth runtime references after the provider is removed while its active stream can finish', async () => {
  saveOAuthAccounts();
  let releaseAlpha = () => {};
  let firstAlpha = true;
  const alphaGate = new Promise<void>(resolve => { releaseAlpha = resolve; });
  const upstream = await startOpenAiUpstream(async (call, response) => {
    if (call.authorization === 'Bearer oauth-alpha-access' && firstAlpha) {
      firstAlpha = false;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      response.write([
        'data: {"type":"response.created","response":{"id":"provider-retirement-response","created_at":1,"model":"gpt-4o-mini"}}',
        '',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"provider-retirement-message"}}',
        '',
        'data: {"type":"response.output_text.delta","item_id":"provider-retirement-message","delta":"provider stream remains active"}',
        '',
        '',
      ].join('\n'));
      await alphaGate;
      response.end('data: {"type":"response.completed","response":{"id":"provider-retirement-response","usage":{"input_tokens":4,"output_tokens":3}}}\n\n');
      return;
    }
    openAiSuccessResponse(response);
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const model = route();
  const proxy = await startProxyCatalog([model], model.aliasId, false);
  const forget = vi.spyOn(ProviderRuntimeCache.prototype, 'forget');

  try {
    const alphaStream = startStreamUntilText(proxy.port, proxy.token, model.aliasId, 'provider stream remains active');
    await alphaStream.firstText;
    saveRegistry({ schemaVersion: 1, providers: [] });
    const unavailable = await postMessages(proxy.port, proxy.token, model.aliasId);
    releaseAlpha();
    const alphaResponse = await alphaStream.completed;

    expect(unavailable.status).toBe(429);
    expect(unavailable.body.toLowerCase()).toContain('pool exhausted');
    expect(alphaResponse.status).toBe(200);
    expect(alphaResponse.body).toContain('provider stream remains active');
    expect(upstream.calls).toHaveLength(1);
    expect(forget).toHaveBeenCalled();
  } finally {
    releaseAlpha();
    await proxy.close();
    await upstream.close();
  }
}, 15_000);
