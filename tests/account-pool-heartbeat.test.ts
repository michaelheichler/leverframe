import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { saveRegistry } from '../src/registry/io.js';
import {
  forwardSdkFetchToLocal,
  startOpenAiUpstream,
} from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let previousHeartbeat: string | undefined;
let fakeKeyring: Map<string, string>;

const alphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000001';
const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000002';

function saveOAuthAccounts(singleAccount = false): void {
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
        ...(!singleAccount ? [{ id: 'beta', authRef: betaRef, enabled: true }] : []),
      ],
    }],
  });
}

function postStream(port: number, token: string, model: string, sessionId: string): {
  ping: Promise<void>;
  completed: Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>;
  chunks: string[];
} {
  const payload = JSON.stringify({
    model, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }], stream: true,
  });
  const chunks: string[] = [];
  let resolvePing = (): void => {};
  let rejectPing = (_error: Error): void => {};
  let resolveCompleted = (_value: { status: number; headers: http.IncomingHttpHeaders; body: string }): void => {};
  let rejectCompleted = (_error: Error): void => {};
  const ping = new Promise<void>((resolve, reject) => { resolvePing = resolve; rejectPing = reject; });
  const completed = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const request = http.request({
    hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Claude-Code-Session-Id': sessionId,
    },
  }, response => {
    const status = response.statusCode ?? 0;
    const headers = response.headers;
    response.on('data', chunk => {
      chunks.push(Buffer.from(chunk).toString('utf8'));
      if (chunks.join('').includes('event: ping')) resolvePing();
    });
    response.on('end', () => resolveCompleted({ status, headers, body: chunks.join('') }));
    response.on('error', rejectCompleted);
  });
  request.on('error', error => {
    rejectPing(error);
    rejectCompleted(error);
  });
  request.end(payload);
  return { ping, completed, chunks };
}

function postMessages(port: number, token: string, model: string, sessionId: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    model, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }], stream: false,
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload), 'X-Claude-Code-Session-Id': sessionId,
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-heartbeat-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousHeartbeat = process.env.LEVERFRAME_SSE_HEARTBEAT_MS;
  fakeKeyring = new Map();
  process.env.LEVERFRAME_HOME = home;
  process.env.LEVERFRAME_SSE_HEARTBEAT_MS = '10';
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

it('starts a pooled stream before its first SDK event and prevents late quota replay', async () => {
  saveOAuthAccounts(true);
  const sessionId = 'late-quota-session';
  let resolveStarted = (): void => {};
  let releaseFirstResponse = (): void => {};
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const firstResponseReleased = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const upstream = await startOpenAiUpstream(async (_call, response) => {
    resolveStarted();
    await firstResponseReleased;
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
  const route: ProxyRoute = {
    aliasId: 'openai-oauth__gpt-4o-mini', realModelId: 'gpt-4o-mini',
    displayName: 'ChatGPT OAuth fixture', upstreamUrl: '', apiKey: 'route-snapshot-oauth-token',
    modelFormat: 'openai', npm: '@ai-sdk/openai', providerId: 'openai-oauth', authType: 'oauth',
    preferWebSockets: false,
  };
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const stream = postStream(proxy.port, proxy.token, route.aliasId, sessionId);
    const requestStarted = await Promise.race([
      started.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(requestStarted).toBe(true);
    const pingReceived = await Promise.race([
      stream.ping.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    releaseFirstResponse();
    const response = await stream.completed;
    const chunkCount = stream.chunks.length;
    await new Promise(resolve => setTimeout(resolve, 30));
    const followup = await postMessages(proxy.port, proxy.token, route.aliasId, sessionId);

    expect(pingReceived).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toContain('event: ping');
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('limit reached');
    expect(response.headers['x-leverframe-execution-id']).toBeTruthy();
    expect(response.headers['x-leverframe-generation']).toBeTruthy();
    expect(stream.chunks).toHaveLength(chunkCount);
    expect(followup.status).toBe(429);
    expect(followup.body).toMatch(/pool exhausted|unavailable/i);
    expect(upstream.calls).toHaveLength(1);
  } finally {
    releaseFirstResponse();
    await proxy.close();
    await upstream.close();
  }
}, 15_000);
