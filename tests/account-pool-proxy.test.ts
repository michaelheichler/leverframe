import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import {
  bounded,
  connectMitm,
  messageResponse,
  quotaResponse,
  sendMitmMessages,
  startNativeUpstream,
} from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let previousAlpha: string | undefined;
let previousBeta: string | undefined;
let previousOldAlpha: string | undefined;
let previousNewAlpha: string | undefined;
let fakeKeyring: Map<string, string>;

function saveAnthropicProvider(pinnedAccountId?: string): void {
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', api: {}, addedAt: '2026-01-01',
      ...(pinnedAccountId ? { pinnedAccountId } : {}),
      accounts: [
        { id: 'alpha', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', enabled: true },
        { id: 'beta', authRef: 'env:ACCOUNT_BETA_FIXTURE', enabled: true },
      ],
    }],
  });
}

function httpPassthroughRoute(upstreamUrl: string): ProxyRoute {
  return {
    ...route(upstreamUrl),
    aliasId: 'leverframe:anthropic-api:claude-native-fixture',
  };
}

function route(upstreamUrl: string): ProxyRoute {
  return {
    aliasId: 'anthropic-api__claude-native-fixture',
    realModelId: 'claude-native-fixture',
    displayName: 'Native fixture model',
    upstreamUrl,
    apiKey: 'route-snapshot-credential',
    modelFormat: 'anthropic',
    npm: '@ai-sdk/anthropic',
    providerId: 'anthropic-api',
    authType: 'api',
  };
}

function postMessages(
  port: number,
  token: string,
  stream = false,
  model = 'anthropic-api__claude-native-fixture',
  sessionId?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'fixture request' }],
      stream,
    });
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(sessionId ? { 'X-Claude-Code-Session-Id': sessionId } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-proxy-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousAlpha = process.env.ACCOUNT_ALPHA_FIXTURE;
  previousBeta = process.env.ACCOUNT_BETA_FIXTURE;
  previousOldAlpha = process.env.ACCOUNT_ALPHA_OLD;
  previousNewAlpha = process.env.ACCOUNT_ALPHA_NEW;
  fakeKeyring = new Map();
  process.env.LEVERFRAME_HOME = home;
  process.env.ACCOUNT_ALPHA_FIXTURE = 'alpha-local-credential';
  process.env.ACCOUNT_BETA_FIXTURE = 'beta-local-credential';
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    }
    if (input.operation === 'write') {
      fakeKeyring.set(input.account, input.value);
      return { ok: true, value: null };
    }
    if (input.operation === 'delete') {
      fakeKeyring.delete(input.account);
      return { ok: true, value: null };
    }
    return { ok: true, value: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousAlpha === undefined) delete process.env.ACCOUNT_ALPHA_FIXTURE;
  else process.env.ACCOUNT_ALPHA_FIXTURE = previousAlpha;
  if (previousBeta === undefined) delete process.env.ACCOUNT_BETA_FIXTURE;
  else process.env.ACCOUNT_BETA_FIXTURE = previousBeta;
  if (previousOldAlpha === undefined) delete process.env.ACCOUNT_ALPHA_OLD;
  else process.env.ACCOUNT_ALPHA_OLD = previousOldAlpha;
  if (previousNewAlpha === undefined) delete process.env.ACCOUNT_ALPHA_NEW;
  else process.env.ACCOUNT_ALPHA_NEW = previousNewAlpha;
  rmSync(home, { recursive: true, force: true });
});

it('fails over a native Anthropic quota rejection to another configured account', async () => {
  saveAnthropicProvider();
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'alpha-local-credential') quotaResponse(response);
    else messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      content: [{ text: 'alternate account response' }],
      model: 'anthropic-api__claude-native-fixture',
    });
    expect(upstream.calls).toEqual([
      { key: 'alpha-local-credential', model: 'claude-native-fixture' },
      { key: 'beta-local-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('keeps an explicit standalone route working without a registry provider', async () => {
  const upstream = await startNativeUpstream((_call, response) => messageResponse(response));
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ content: [{ text: 'alternate account response' }] });
    expect(upstream.calls).toEqual([
      { key: 'route-snapshot-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('dispatches an HTTP proxy model alias through the configured native account pool', async () => {
  saveAnthropicProvider();
  const certificates = ensureHttpProxyCertificates();
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'alpha-local-credential') quotaResponse(response);
    else messageResponse(response);
  });
  const proxy = await startHttpProxy({
    routes: [httpPassthroughRoute(`http://127.0.0.1:${upstream.port}`)],
    anthropicOrigin: 'https://127.0.0.1:1',
    anthropicRejectUnauthorized: false,
  });

  try {
    const tunnel = await bounded(connectMitm(proxy.port, proxy.token, certificates.caCert), 'MITM TLS handshake timed out');
    const response = await bounded(
      sendMitmMessages(tunnel, 'leverframe:anthropic-api:claude-native-fixture'),
      'HTTP proxy request did not close after the local upstream response',
    );

    expect(response).toContain('HTTP/1.1 200');
    expect(upstream.calls).toEqual([
      { key: 'alpha-local-credential', model: 'claude-native-fixture' },
      { key: 'beta-local-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
}, 30_000);

it('does not dispatch a quota rejection to a second account when failover is disabled', async () => {
  saveAnthropicProvider();
  savePreferences({ accountPoolFailover: false });
  const upstream = await startNativeUpstream((_call, response) => quotaResponse(response));
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(429);
    expect(upstream.calls).toEqual([
      { key: 'alpha-local-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('uses the pinned account when balancing is independently disabled', async () => {
  saveAnthropicProvider('beta');
  savePreferences({ accountPoolBalancing: false });
  const upstream = await startNativeUpstream((_call, response) => messageResponse(response));
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(200);
    expect(upstream.calls).toEqual([
      { key: 'beta-local-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('routes a previously quota-blocked pinned account to an alternate on the next request', async () => {
  saveAnthropicProvider('alpha');
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'alpha-local-credential') quotaResponse(response);
    else messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const first = await postMessages(proxy.port, proxy.token);
    const next = await postMessages(proxy.port, proxy.token);

    expect([first.status, next.status]).toEqual([200, 200]);
    expect(upstream.calls.map(call => call.key)).toEqual([
      'alpha-local-credential', 'beta-local-credential', 'beta-local-credential',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('does not carry an old account failure to a replacement credential with the same account ID', async () => {
  const oldAuthRef = 'env:ACCOUNT_ALPHA_OLD';
  const newAuthRef = 'env:ACCOUNT_ALPHA_NEW';
  process.env.ACCOUNT_ALPHA_OLD = 'old-alpha-credential';
  process.env.ACCOUNT_ALPHA_NEW = 'fresh-alpha-credential';
  process.env.ACCOUNT_ALPHA_FIXTURE = process.env.ACCOUNT_ALPHA_OLD;
  const statePath = join(home, 'account-pool-state.json');
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: false });
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef: oldAuthRef, pinnedAccountId: 'alpha', api: {}, addedAt: '2026-01-01',
      accounts: [{ id: 'alpha', authRef: oldAuthRef, enabled: true }],
    }],
  });
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'old-alpha-credential') quotaResponse(response);
    else messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const first = await postMessages(proxy.port, proxy.token);
    saveRegistry({
      schemaVersion: 1,
      providers: [{
        id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
        authType: 'api', authRef: newAuthRef, pinnedAccountId: 'alpha', api: {}, addedAt: '2026-01-01',
        accounts: [{ id: 'alpha', authRef: newAuthRef, enabled: true }],
      }],
    });
    const next = await postMessages(proxy.port, proxy.token);

    expect([first.status, next.status]).toEqual([429, 200]);
    expect(upstream.calls).toEqual([
      { key: 'old-alpha-credential', model: 'claude-native-fixture' },
      { key: 'fresh-alpha-credential', model: 'claude-native-fixture' },
    ]);
    const state = readFileSync(statePath, 'utf8');
    expect(state).not.toContain(oldAuthRef);
    expect(state).not.toContain(newAuthRef);
    expect(state).not.toContain('old-alpha-credential');
    expect(state).not.toContain('fresh-alpha-credential');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('does not use the route snapshot when every configured account is disabled', async () => {
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', enabled: false },
        { id: 'beta', authRef: 'env:ACCOUNT_BETA_FIXTURE', enabled: false },
      ],
    }],
  });
  const upstream = await startNativeUpstream((_call, response) => messageResponse(response));
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(429);
    expect(response.body.toLowerCase()).toContain('pool exhausted');
    expect(upstream.calls).toEqual([]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('keeps an in-flight request alive but refuses snapshot fallback after its configured provider is removed', async () => {
  saveAnthropicProvider();
  let releaseStream = () => {};
  let signalStreamStarted = () => {};
  let first = true;
  const streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
  const streamStarted = new Promise<void>(resolve => { signalStreamStarted = resolve; });
  const upstream = await startNativeUpstream(async (_call, response) => {
    if (first) {
      first = false;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      signalStreamStarted();
      await streamGate;
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      return;
    }
    messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const inFlight = postMessages(proxy.port, proxy.token, true);
    await streamStarted;
    saveRegistry({ schemaVersion: 1, providers: [] });
    const afterRemoval = await postMessages(proxy.port, proxy.token);
    releaseStream();
    const completedStream = await inFlight;

    expect(completedStream.status).toBe(200);
    expect(completedStream.body).toContain('message_start');
    expect(completedStream.body).toContain('message_stop');
    expect(afterRemoval.status).toBe(429);
    expect(afterRemoval.body.toLowerCase()).toContain('pool');
    expect(afterRemoval.body).not.toContain('route-snapshot-credential');
    expect(upstream.calls).toEqual([
      { key: 'alpha-local-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    releaseStream();
    await proxy.close();
    await upstream.close();
  }
}, 15_000);
it('does not retry a native request after partial SSE output', async () => {
  saveAnthropicProvider();
  const upstream = await startNativeUpstream((_call, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    setTimeout(() => response.destroy(), 20);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token, true);

    expect(response.status).toBe(200);
    expect(response.body).toContain('event: message_start');
    expect(upstream.calls).toHaveLength(1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
}, 15_000);

it('does not fail over after an ambiguous native timeout before response headers', async () => {
  saveAnthropicProvider();
  const upstream = await startNativeUpstream((_call, response) => {
    response.destroy();
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).not.toBe(200);
    expect(upstream.calls).toEqual([
      { key: 'alpha-local-credential', model: 'claude-native-fixture' },
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
}, 15_000);
