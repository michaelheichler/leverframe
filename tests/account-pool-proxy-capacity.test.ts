import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';
import { messageResponse, quotaResponse, startNativeUpstream } from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let previousAlpha: string | undefined;
let previousBeta: string | undefined;

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

function route(upstreamUrl: string): ProxyRoute {
  return {
    aliasId: 'anthropic-api__claude-native-fixture', realModelId: 'claude-native-fixture',
    displayName: 'Native fixture model', upstreamUrl, apiKey: 'route-snapshot-credential',
    modelFormat: 'anthropic', npm: '@ai-sdk/anthropic', providerId: 'anthropic-api', authType: 'api',
  };
}

function postMessages(port: number, token: string, stream = false, sessionId?: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    model: 'anthropic-api__claude-native-fixture', max_tokens: 20,
    messages: [{ role: 'user', content: 'fixture request' }], stream,
  });
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      ...(sessionId ? { 'X-Claude-Code-Session-Id': sessionId } : {}),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-capacity-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousAlpha = process.env.ACCOUNT_ALPHA_FIXTURE;
  previousBeta = process.env.ACCOUNT_BETA_FIXTURE;
  process.env.LEVERFRAME_HOME = home;
  process.env.ACCOUNT_ALPHA_FIXTURE = 'alpha-local-credential';
  process.env.ACCOUNT_BETA_FIXTURE = 'beta-local-credential';
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousAlpha === undefined) delete process.env.ACCOUNT_ALPHA_FIXTURE;
  else process.env.ACCOUNT_ALPHA_FIXTURE = previousAlpha;
  if (previousBeta === undefined) delete process.env.ACCOUNT_BETA_FIXTURE;
  else process.env.ACCOUNT_BETA_FIXTURE = previousBeta;
  rmSync(home, { recursive: true, force: true });
});

it('returns confirmed exhaustion with attempted account IDs and reset but no credential or session data', async () => {
  saveAnthropicProvider();
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const upstream = await startNativeUpstream((_call, response) => quotaResponse(response, resetAt));
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');
  const sessionId = '22222222-2222-4222-8222-222222222222';

  try {
    const response = await postMessages(proxy.port, proxy.token, false, sessionId);

    expect(response.status).toBe(429);
    expect(response.body.toLowerCase()).toContain('pool exhausted');
    expect(response.body).toContain('alpha');
    expect(response.body).toContain('beta');
    expect(response.body).toContain(resetAt);
    expect(response.body).not.toContain('alpha-local-credential');
    expect(response.body).not.toContain('beta-local-credential');
    expect(response.body).not.toContain(sessionId);
    expect(upstream.calls.map(call => call.key)).toEqual(['alpha-local-credential', 'beta-local-credential']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('does not claim a reset time when an exhausted pool provides no confirmed reset', async () => {
  saveAnthropicProvider();
  const upstream = await startNativeUpstream((_call, response) => quotaResponse(response, null));
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(429);
    expect(response.body.toLowerCase()).toContain('pool exhausted');
    expect(response.body).toContain('alpha');
    expect(response.body).toContain('beta');
    expect(response.body).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T\d{2}:/);
    expect(upstream.calls.map(call => call.key)).toEqual(['alpha-local-credential', 'beta-local-credential']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('withholds a reset when any exhausted Anthropic quota window has none', async () => {
  saveAnthropicProvider();
  const confirmedWindow = new Date(Date.now() + 60_000).toISOString();
  const upstream = await startNativeUpstream((_call, response) => {
    response.writeHead(429, {
      'Content-Type': 'application/json',
      'anthropic-ratelimit-requests-remaining': '0',
      'anthropic-ratelimit-requests-reset': confirmedWindow,
      'anthropic-ratelimit-input-tokens-remaining': '0',
    });
    response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limited' } }));
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(429);
    expect(response.body.toLowerCase()).toContain('pool exhausted');
    expect(response.body).not.toContain(confirmedWindow);
    expect(upstream.calls.map(call => call.key)).toEqual(['alpha-local-credential', 'beta-local-credential']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('does not report one reset when separate blocked capacity dimensions disagree', async () => {
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', api: {}, addedAt: '2026-01-01',
      accounts: [{ id: 'alpha', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', enabled: true }],
    }],
  });
  const knownReset = new Date(Date.now() + 60_000).toISOString();
  const upstream = await startNativeUpstream((_call, response) => messageResponse(response, {
    'anthropic-ratelimit-requests-remaining': '0',
    'anthropic-ratelimit-requests-reset': knownReset,
    'anthropic-ratelimit-input-tokens-remaining': '0',
  }));
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const healthyResponse = await postMessages(proxy.port, proxy.token);
    const exhaustedResponse = await postMessages(proxy.port, proxy.token);

    expect(healthyResponse.status).toBe(200);
    expect(exhaustedResponse.status).toBe(429);
    expect(exhaustedResponse.body.toLowerCase()).toContain('pool exhausted');
    expect(exhaustedResponse.body).not.toContain(knownReset);
    expect(upstream.calls).toHaveLength(1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('fails over a native request after any upstream HTTP 429', async () => {
  saveAnthropicProvider();
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'alpha-local-credential') {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream rejected this request' } }));
      return;
    }
    messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(200);
    expect(response.body).toContain('alternate account response');
    expect(upstream.calls.map(call => call.key)).toEqual(['alpha-local-credential', 'beta-local-credential']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('ranks native requests using all comparable Anthropic capacity windows', async () => {
  saveAnthropicProvider();
  const upstream = await startNativeUpstream((call, response) => {
    messageResponse(response, {
      'anthropic-ratelimit-requests-remaining': call.key === 'alpha-local-credential' ? '2' : '8',
      'anthropic-ratelimit-requests-reset': new Date(Date.now() + 60_000).toISOString(),
      'anthropic-ratelimit-input-tokens-remaining': call.key === 'alpha-local-credential' ? '10' : '50',
      'anthropic-ratelimit-input-tokens-reset': new Date(Date.now() + 60_000).toISOString(),
      'anthropic-ratelimit-output-tokens-remaining': call.key === 'alpha-local-credential' ? '20' : '80',
      'anthropic-ratelimit-output-tokens-reset': new Date(Date.now() + 60_000).toISOString(),
    });
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const first = await postMessages(proxy.port, proxy.token);
    const second = await postMessages(proxy.port, proxy.token);
    const third = await postMessages(proxy.port, proxy.token);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(upstream.calls.map(call => call.key)).toEqual([
      'alpha-local-credential', 'beta-local-credential', 'beta-local-credential',
    ]);
    expect(upstream.calls.map(call => call.model)).toEqual([
      'claude-native-fixture', 'claude-native-fixture', 'claude-native-fixture',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('keeps an exhausted input-token window from being cleared by a healthy request window', async () => {
  saveAnthropicProvider();
  const upstream = await startNativeUpstream((call, response) => {
    messageResponse(response, call.key === 'alpha-local-credential' ? {
      'anthropic-ratelimit-requests-remaining': '50',
      'anthropic-ratelimit-requests-reset': new Date(Date.now() + 60_000).toISOString(),
      'anthropic-ratelimit-input-tokens-remaining': '0',
      'anthropic-ratelimit-input-tokens-reset': new Date(Date.now() + 60_000).toISOString(),
    } : {
      'anthropic-ratelimit-requests-remaining': '5',
      'anthropic-ratelimit-requests-reset': new Date(Date.now() + 60_000).toISOString(),
      'anthropic-ratelimit-input-tokens-remaining': '5',
      'anthropic-ratelimit-input-tokens-reset': new Date(Date.now() + 60_000).toISOString(),
    });
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    await postMessages(proxy.port, proxy.token);
    await postMessages(proxy.port, proxy.token);
    await postMessages(proxy.port, proxy.token);

    expect(upstream.calls.map(call => call.key)).toEqual([
      'alpha-local-credential', 'beta-local-credential', 'beta-local-credential',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('keeps a newer exhausted token window when an older in-flight response reports healthy request capacity', async () => {
  saveAnthropicProvider('alpha');
  savePreferences({ accountPoolBalancing: false });
  let requestNumber = 0;
  let releaseFirstResponse = () => {};
  let firstRequestSeen = () => {};
  const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const firstRequest = new Promise<void>(resolve => { firstRequestSeen = resolve; });
  const upstream = await startNativeUpstream(async (call, response) => {
    requestNumber += 1;
    if (call.key === 'alpha-local-credential' && requestNumber === 1) {
      firstRequestSeen();
      await firstResponseGate;
      messageResponse(response, {
        'anthropic-ratelimit-requests-remaining': '50',
        'anthropic-ratelimit-requests-reset': new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }
    if (call.key === 'alpha-local-credential' && requestNumber === 2) {
      messageResponse(response, {
        'anthropic-ratelimit-requests-remaining': '50',
        'anthropic-ratelimit-requests-reset': new Date(Date.now() + 60_000).toISOString(),
        'anthropic-ratelimit-input-tokens-remaining': '0',
        'anthropic-ratelimit-input-tokens-reset': new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }
    messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');
  const sessionId = '11111111-1111-4111-8111-111111111111';

  try {
    const firstRequestResponse = postMessages(proxy.port, proxy.token, false, sessionId);
    await firstRequest;
    const secondResponse = await postMessages(proxy.port, proxy.token);
    releaseFirstResponse();
    const firstResponse = await firstRequestResponse;
    saveAnthropicProvider();
    const nextRequest = await postMessages(proxy.port, proxy.token, false, sessionId);

    expect([firstResponse.status, secondResponse.status, nextRequest.status]).toEqual([200, 200, 200]);
    expect(upstream.calls.map(call => call.key)).toEqual([
      'alpha-local-credential', 'alpha-local-credential', 'beta-local-credential',
    ]);
  } finally {
    releaseFirstResponse();
    await proxy.close();
    await upstream.close();
  }
}, 20_000);
