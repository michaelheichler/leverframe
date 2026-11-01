import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { saveRegistry } from '../src/registry/io.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { startNativeUpstream } from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let previousAlpha: string | undefined;
let fakeKeyring: Map<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-native-usage-audit-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousAlpha = process.env.ACCOUNT_ALPHA_FIXTURE;
  fakeKeyring = new Map();
  process.env.LEVERFRAME_HOME = home;
  process.env.ACCOUNT_ALPHA_FIXTURE = 'alpha-local-credential';
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    if (input.operation === 'write') fakeKeyring.set(input.account, input.value);
    if (input.operation === 'delete') fakeKeyring.delete(input.account);
    return { ok: true, value: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousAlpha === undefined) delete process.env.ACCOUNT_ALPHA_FIXTURE;
  else process.env.ACCOUNT_ALPHA_FIXTURE = previousAlpha;
  rmSync(home, { recursive: true, force: true });
});

function saveProvider(): void {
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
    authType: 'api', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', api: {}, addedAt: '2026-01-01',
    accounts: [{ id: 'alpha', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', enabled: true }],
  }] });
}

function route(upstreamUrl: string): ProxyRoute {
  return {
    aliasId: 'anthropic-api__claude-native-fixture', realModelId: 'claude-native-fixture',
    displayName: 'Native fixture model', upstreamUrl, apiKey: 'route-snapshot-credential',
    modelFormat: 'anthropic', npm: '@ai-sdk/anthropic', providerId: 'anthropic-api', authType: 'api',
  };
}

function postMessages(port: number, token: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    model: 'anthropic-api__claude-native-fixture', max_tokens: 20,
    messages: [{ role: 'user', content: 'fixture request' }], stream: false,
  });
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

it('logs measured native usage with selected account identity and omits unknown fields', async () => {
  saveProvider();
  const logPath = join(home, 'usage.jsonl');
  const upstream = await startNativeUpstream((_call, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      type: 'message', model: 'claude-native-fixture', content: [{ type: 'text', text: 'fixture result' }],
      stop_reason: 'end_turn', usage: { output_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 4 } },
    }));
  });
  const proxy = await startProxyCatalog(
    [route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture', false, logPath,
  );

  try {
    expect((await postMessages(proxy.port, proxy.token)).status).toBe(200);
    const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const usage = entries.find(entry => entry.event === 'response_usage');

    expect(usage).toMatchObject({
      usageStage: 'message_delta', accountId: 'alpha',
      outputTokens: 3, cacheCreation5mInputTokens: 4,
    });
    expect(usage).not.toHaveProperty('inputTokens');
    expect(usage).not.toHaveProperty('totalInputTokens');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
