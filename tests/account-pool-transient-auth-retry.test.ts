import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { saveRegistry } from '../src/registry/io.js';
import { forwardSdkFetchToLocal, startOpenAiUpstream } from './fixtures/account-pool-proxy.js';

const transientMessage = 'authentication failed (status=503): {"error":"Too many concurrent requests"}';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function configureAccount() {
  const home = process.env['LEVERFRAME_TEST_HOME'];
  if (!home) throw new Error('isolated test home is missing');
  vi.stubEnv('LEVERFRAME_HOME', join(home, randomUUID()));
  vi.stubEnv('LEVERFRAME_RETRY_FIXTURE_CREDENTIAL', randomUUID());
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'openai-oauth', templateId: 'openai-oauth', name: 'OAuth retry fixture', enabled: true,
    authType: 'oauth', authRef: 'env:LEVERFRAME_RETRY_FIXTURE_CREDENTIAL', api: {}, addedAt: '2026-11-12',
    accounts: [{ id: 'only', authRef: 'env:LEVERFRAME_RETRY_FIXTURE_CREDENTIAL', enabled: true }],
  }] });
}

async function retryFixture(message: string) {
  configureAccount();
  const upstream = await startOpenAiUpstream();
  onTestFinished(() => upstream.close());
  const attempts: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    attempts.push({ url: request.url, method: request.method, body, headers: Object.fromEntries(request.headers) });
    if (attempts.length === 1) return Response.json({ error: { message, type: 'authentication_error' } }, { status: 401 });
    return forwardSdkFetchToLocal(request, undefined, upstream.port);
  });
  const route: ProxyRoute = {
    aliasId: 'openai-oauth__gpt-4o-mini', realModelId: 'gpt-4o-mini', displayName: 'OAuth retry fixture',
    upstreamUrl: '', apiKey: '', modelFormat: 'openai', npm: '@ai-sdk/openai',
    providerId: 'openai-oauth', authType: 'oauth', preferWebSockets: false,
  };
  const proxy = await startProxyCatalog([route], route.aliasId, false);
  onTestFinished(() => proxy.close());
  return { proxy, attempts, model: route.aliasId };
}

function postMessages(fixture: Awaited<ReturnType<typeof retryFixture>>) {
  const sessionId = randomUUID();
  const prefix = `Keep this cacheable instruction unchanged: ${randomUUID()}.`;
  const payload = JSON.stringify({ model: fixture.model, max_tokens: 20, stream: false,
    system: [{ type: 'text', text: `You are Claude Code, Anthropic's official CLI for Claude.\n${prefix}`,
      cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: 'Reply accepted' }] });
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: fixture.proxy.port, path: '/v1/messages', method: 'POST',
      headers: { Authorization: `Bearer ${fixture.proxy.token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload), 'X-Claude-Code-Session-Id': sessionId } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      incoming.once('error', reject);
    });
    request.once('error', reject);
    request.end(payload);
  });
  return { response, prefix };
}

it('retries a transient OAuth authentication outage with an unchanged neutral cacheable request and returns success', async () => {
  const fixture = await retryFixture(transientMessage);

  const { response, prefix } = postMessages(fixture);
  const result = await response;

  expect(fixture.attempts[0]?.body).not.toContain('Claude Code');
  expect(fixture.attempts[0]?.body).toContain(prefix);
  expect(JSON.parse(fixture.attempts[0]?.body ?? '{}').prompt_cache_key).toBeTruthy();
  expect(result.status).toBe(200);
  expect(fixture.attempts).toHaveLength(2);
  expect(fixture.attempts[1]).toEqual(fixture.attempts[0]);
}, 10_000);

it('returns a genuine OAuth credential rejection without a retry', async () => {
  const fixture = await retryFixture('invalid token');

  const { response } = postMessages(fixture);
  const result = await response;

  expect(result.status).toBe(401);
  expect(fixture.attempts).toHaveLength(1);
});
