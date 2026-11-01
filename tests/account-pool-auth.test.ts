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
  messageResponse,
  openAiSuccessResponse,
  startNativeUpstream,
  startOpenAiUpstream,
} from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let previousAlpha: string | undefined;
let previousBeta: string | undefined;
let previousRepairedAlpha: string | undefined;
let fakeKeyring: Map<string, string>;

const authError = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid credential' } });

function route(upstreamUrl: string): ProxyRoute {
  return {
    aliasId: 'anthropic-api__claude-native-fixture', realModelId: 'claude-native-fixture',
    displayName: 'Native fixture model', upstreamUrl, apiKey: 'route-snapshot-credential',
    modelFormat: 'anthropic', npm: '@ai-sdk/anthropic', providerId: 'anthropic-api', authType: 'api',
  };
}

function saveAccounts(authRef = 'env:ACCOUNT_ALPHA_FIXTURE', single = false): void {
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef, api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef, enabled: true },
        ...(!single ? [{ id: 'beta', authRef: 'env:ACCOUNT_BETA_FIXTURE', enabled: true }] : []),
      ],
    }],
  });
}

function saveOAuthAccounts(single = false): void {
  const alphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000001';
  const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000002';
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
        ...(!single ? [{ id: 'beta', authRef: betaRef, enabled: true }] : []),
      ],
    }],
  });
}

function oauthRoute(): ProxyRoute {
  return {
    aliasId: 'openai-oauth__gpt-4o-mini', realModelId: 'gpt-4o-mini',
    displayName: 'ChatGPT OAuth fixture', upstreamUrl: '', apiKey: 'route-snapshot-oauth-token',
    modelFormat: 'openai', npm: '@ai-sdk/openai', providerId: 'openai-oauth', authType: 'oauth',
    preferWebSockets: false,
  };
}

function postMessages(port: number, token: string, sessionId?: string, model = 'anthropic-api__claude-native-fixture'):
Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    model, max_tokens: 20,
    messages: [{ role: 'user', content: 'fixture request' }], stream: false,
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(sessionId ? { 'X-Claude-Code-Session-Id': sessionId } : {}),
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
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-auth-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousAlpha = process.env.ACCOUNT_ALPHA_FIXTURE;
  previousBeta = process.env.ACCOUNT_BETA_FIXTURE;
  previousRepairedAlpha = process.env.ACCOUNT_ALPHA_REPAIRED;
  fakeKeyring = new Map();
  process.env.LEVERFRAME_HOME = home;
  process.env.ACCOUNT_ALPHA_FIXTURE = 'alpha-local-credential';
  process.env.ACCOUNT_BETA_FIXTURE = 'beta-local-credential';
  process.env.ACCOUNT_ALPHA_REPAIRED = 'alpha-repaired-credential';
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
  if (previousRepairedAlpha === undefined) delete process.env.ACCOUNT_ALPHA_REPAIRED;
  else process.env.ACCOUNT_ALPHA_REPAIRED = previousRepairedAlpha;
  rmSync(home, { recursive: true, force: true });
});

it('returns the original authentication response without trying another account', async () => {
  saveAccounts();
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'alpha-local-credential') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(authError);
      return;
    }
    messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(401);
    expect(response.body).toBe(authError);
    expect(upstream.calls.map(call => call.key)).toEqual(['alpha-local-credential']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('avoids a credential after authentication failure and restores it after repair', async () => {
  saveAccounts(undefined, true);
  const upstream = await startNativeUpstream((call, response) => {
    if (call.key === 'alpha-local-credential') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(authError);
      return;
    }
    messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const rejected = await postMessages(proxy.port, proxy.token, 'auth-repair-session');
    const blocked = await postMessages(proxy.port, proxy.token, 'auth-repair-session');
    saveAccounts('env:ACCOUNT_ALPHA_REPAIRED', true);
    const repaired = await postMessages(proxy.port, proxy.token, 'auth-repair-session');

    expect(rejected.status).toBe(401);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatch(/auth/i);
    expect(blocked.body).toMatch(/credential|repair/i);
    expect(blocked.body).not.toContain('alpha-local-credential');
    expect(repaired.status).toBe(200);
    expect(upstream.calls.map(call => call.key)).toEqual([
      'alpha-local-credential', 'alpha-repaired-credential',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('moves a failed OAuth credential out of affinity after the current response', async () => {
  saveOAuthAccounts(true);
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    }
    if (input.operation === 'write') fakeKeyring.set(input.account, input.value);
    if (input.operation === 'delete') fakeKeyring.delete(input.account);
    return { ok: true, value: null };
  });
  const upstream = await startOpenAiUpstream((call, response) => {
    if (call.authorization === 'Bearer oauth-alpha-access') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(authError);
      return;
    }
    openAiSuccessResponse(response);
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const oauth = oauthRoute();
  const proxy = await startProxyCatalog([oauth], oauth.aliasId, false);

  try {
    const rejected = await postMessages(proxy.port, proxy.token, 'oauth-auth-session', oauth.aliasId);
    const blocked = await postMessages(proxy.port, proxy.token, 'oauth-auth-session', oauth.aliasId);

    expect(rejected.status).toBe(401);
    expect(blocked.status).toBe(429);
    expect(upstream.calls.map(call => call.authorization)).toEqual(['Bearer oauth-alpha-access']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
