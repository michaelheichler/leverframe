import http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { applyRequestContextPolicy } from '../src/context/request-policy.js';
import * as requestPolicy from '../src/context/request-policy.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { saveRegistry } from '../src/registry/io.js';
import { startServer } from '../src/server/router.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { bounded, connectMitm } from './fixtures/account-pool-proxy.js';

type CapturedRequest = { key: string | undefined; beta: string | undefined; fixtureHeader?: string; rawBody?: string; body: Record<string, unknown> };

async function startContextUpstream(received: CapturedRequest[]): Promise<{ port: number; close: () => Promise<void> }> {
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const key = request.headers['x-api-key'];
    const beta = request.headers['anthropic-beta'];
    received.push({
      key: Array.isArray(key) ? key[0] : key,
      beta: Array.isArray(beta) ? beta[0] : beta,
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
    });
    if (key === 'context-alpha-fixture-key') {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limited' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'context-policy-response', type: 'message', role: 'assistant', model: 'claude-native-fixture',
      content: [{ type: 'text', text: 'local upstream response' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 2 },
    }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Local context upstream failed to bind');
  return {
    port: address.port,
    close: async () => {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    },
  };
}

async function startContextHttpsOrigin(received: CapturedRequest[], certificates: ReturnType<typeof ensureHttpProxyCertificates>): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const origin = https.createServer({ key: certificates.serverKey, cert: certificates.serverCert }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const key = request.headers['x-api-key'];
    const beta = request.headers['anthropic-beta'];
    const fixtureHeader = request.headers['x-context-fixture'];
    const rawBody = Buffer.concat(chunks).toString();
    received.push({
      key: Array.isArray(key) ? key[0] : key,
      beta: Array.isArray(beta) ? beta[0] : beta,
      fixtureHeader: Array.isArray(fixtureHeader) ? fixtureHeader[0] : fixtureHeader,
      rawBody,
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify({
      id: 'context-policy-response', type: 'message', role: 'assistant', model: 'claude-native-fixture',
      content: [{ type: 'text', text: 'local upstream response' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 2 },
    }));
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address();
  if (!address || typeof address === 'string') throw new Error('Local HTTPS origin failed to bind');
  return {
    port: address.port,
    close: async () => {
      origin.closeAllConnections();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    },
  };
}

function contextProxyRoute(upstreamPort: number): ProxyRoute {
  return {
    aliasId: 'anthropic-api__claude-native-fixture', realModelId: 'claude-native-fixture',
    displayName: 'Context policy fixture', upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'route-snapshot-key', modelFormat: 'anthropic', npm: '@ai-sdk/anthropic',
    providerId: 'anthropic-api', authType: 'api', contextWindow: 128_000,
  };
}

function contextRequestBody(model: string): Record<string, unknown> {
  return {
    model, max_tokens: 321,
    system: [{ type: 'text', text: 'Preserve this instruction.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep this source.', cache_control: { type: 'ephemeral' } }] }],
    tools: [{ name: 'lookup', description: 'Look up a fixture.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
    context_management: [{
      type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 50_000 }, keep: { type: 'tool_uses', value: 3 },
    }],
    stream: true,
  };
}

async function startContextProxyFixture(received: CapturedRequest[]) {
  const environment = createContextRegistryEnvironment();
  const upstream = await startContextUpstream(received);
  const route = contextProxyRoute(upstream.port);
  const proxy = await startProxyCatalog([route], route.aliasId);
  return {
    route,
    proxy,
    close: async () => {
      await proxy.close();
      await upstream.close();
      environment.close();
    },
  };
}

function createContextRegistryEnvironment() {
  const previousHome = process.env.LEVERFRAME_HOME;
  const previousAlpha = process.env.CONTEXT_POLICY_ALPHA;
  const previousBeta = process.env.CONTEXT_POLICY_BETA;
  const home = mkdtempSync(join(tmpdir(), 'leverframe-context-policy-proxy-'));
  process.env.LEVERFRAME_HOME = home;
  process.env.CONTEXT_POLICY_ALPHA = 'context-alpha-fixture-key';
  process.env.CONTEXT_POLICY_BETA = 'context-beta-fixture-key';
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef: 'env:CONTEXT_POLICY_ALPHA', api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: 'env:CONTEXT_POLICY_ALPHA', enabled: true },
        { id: 'beta', authRef: 'env:CONTEXT_POLICY_BETA', enabled: true },
      ],
    }],
  });
  return {
    home,
    close: () => {
      if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
      else process.env.LEVERFRAME_HOME = previousHome;
      if (previousAlpha === undefined) delete process.env.CONTEXT_POLICY_ALPHA;
      else process.env.CONTEXT_POLICY_ALPHA = previousAlpha;
      if (previousBeta === undefined) delete process.env.CONTEXT_POLICY_BETA;
      else process.env.CONTEXT_POLICY_BETA = previousBeta;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function postContextProxyRequest(port: number, token: string, body: Record<string, unknown>): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const outgoing = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload), 'anthropic-beta': 'context-cache-fixture',
        'X-Claude-Code-Session-Id': 'context-policy-session', Connection: 'close',
      },
    }, incoming => {
      incoming.resume();
      incoming.on('end', () => resolve(incoming.statusCode ?? 0));
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

function sendContextMitmRequest(socket: tls.TLSSocket, body: Record<string, unknown>, rawBody = JSON.stringify(body), path = '/v1/messages'): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = rawBody;
    let received = '';
    socket.on('data', chunk => { received += chunk.toString(); });
    socket.on('error', reject);
    socket.on('close', () => resolve(received));
    socket.write([
      `POST ${path} HTTP/1.1`,
      'Host: api.anthropic.com',
      'X-API-Key: client-fixture-key',
      'Content-Type: application/json',
      'anthropic-beta: context-cache-fixture',
      'X-Context-Fixture: preserved-header',
      'X-Claude-Code-Session-Id: context-policy-session',
      `Content-Length: ${Buffer.byteLength(payload)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n') + payload);
  });
}

it('preserves client context-management directives when local rewriting is unsupported', async () => {
  const request = {
    model: 'fixture-model',
    system: [{ type: 'text', text: 'Keep the original instructions.' }],
    messages: [{ role: 'user', content: 'Continue the existing work.' }],
    context_management: [{
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: 50_000 },
      keep: { type: 'tool_uses', value: 3 },
    }],
    stream: true,
  };

  const result = await applyRequestContextPolicy({
    request,
    sessionId: 'fixture-session',
    routeIdentity: 'anthropic-api:fixture-model',
    contextWindow: 100_000,
    signal: new AbortController().signal,
  });

  expect(result.request).toEqual(request);
  expect(result.outcome).toBe('unsupported_policy');
  expect(result.reason).toBeTruthy();
});
it('applies request policy once before pool retry and preserves Anthropic directives', async () => {
  const received: CapturedRequest[] = [];
  const fixture = await startContextProxyFixture(received);
  const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');

  try {
    const status = await postContextProxyRequest(
      fixture.proxy.port,
      fixture.proxy.token,
      contextRequestBody(fixture.route.aliasId),
    );

    expect(status).toBe(200);
    expect(received.map(item => item.key)).toEqual([
      'context-alpha-fixture-key', 'context-beta-fixture-key',
    ]);
    expect(received.map(item => item.beta)).toEqual([
      'context-cache-fixture', 'context-cache-fixture',
    ]);
    expect(received.map(item => item.body)).toEqual([
      contextRequestBody(fixture.route.realModelId), contextRequestBody(fixture.route.realModelId),
    ]);
    expect(applyPolicy).toHaveBeenCalledTimes(1);
  } finally {
    await fixture.close();
    vi.restoreAllMocks();
  }
});

it('applies request policy once on the native server route before pool retry', async () => {
  const environment = createContextRegistryEnvironment();
  const received: CapturedRequest[] = [];
  const upstream = await startContextUpstream(received);
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'context-server-key', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'claude-native-fixture', name: 'Context policy fixture', isFree: false,
      brand: 'Anthropic', sourceBackend: 'fixture', modelFormat: 'anthropic',
      providerId: 'anthropic-api', authType: 'api', apiKey: 'server-route-snapshot-key',
      baseUrl: `http://127.0.0.1:${upstream.port}`, contextWindow: 128_000,
    }]),
  });
  const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');

  try {
    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'anthropic-beta': 'context-cache-fixture',
        'X-Claude-Code-Session-Id': 'context-policy-session',
      },
      body: JSON.stringify(contextRequestBody('claude-native-fixture')),
    });

    expect(response.status).toBe(200);
    expect(received.map(item => item.key)).toEqual([
      'context-alpha-fixture-key', 'context-beta-fixture-key',
    ]);
    expect(received.map(item => item.beta)).toEqual([
      'context-cache-fixture', 'context-cache-fixture',
    ]);
    expect(received.map(item => item.body)).toEqual([
      contextRequestBody('claude-native-fixture'), contextRequestBody('claude-native-fixture'),
    ]);
    expect(applyPolicy).toHaveBeenCalledTimes(1);
  } finally {
    await server.close();
    await upstream.close();
    environment.close();
    vi.restoreAllMocks();
  }
});

it('applies request policy once in the HTTP adapter before native account retry', async () => {
  const environment = createContextRegistryEnvironment();
  const certificates = ensureHttpProxyCertificates();
  const received: CapturedRequest[] = [];
  const upstream = await startContextUpstream(received);
  const route = {
    ...contextProxyRoute(upstream.port),
    aliasId: 'leverframe:anthropic-api:claude-native-fixture',
  };
  const proxy = await startHttpProxy({
    routes: [route],
    anthropicOrigin: 'https://127.0.0.1:1',
    anthropicRejectUnauthorized: false,
  });
  const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');

  try {
    const secure = await bounded(
      connectMitm(proxy.port, proxy.token, certificates.caCert),
      'Context HTTP proxy TLS handshake timed out',
    );
    const response = await bounded(
      sendContextMitmRequest(secure, contextRequestBody(route.aliasId)),
      'Context HTTP passthrough response did not close',
    );

    expect(response).toContain('HTTP/1.1 200');
    expect(received.map(item => item.key)).toEqual([
      'context-alpha-fixture-key', 'context-beta-fixture-key',
    ]);
    expect(received.map(item => item.beta)).toEqual([
      'context-cache-fixture', 'context-cache-fixture',
    ]);
    expect(received.map(item => item.body)).toEqual([
      contextRequestBody('claude-native-fixture'), contextRequestBody('claude-native-fixture'),
    ]);
    expect(applyPolicy).toHaveBeenCalledTimes(1);
  } finally {
    await proxy.close();
    await upstream.close();
    environment.close();
    vi.restoreAllMocks();
  }
}, 20_000);

it('applies request policy once on the native HTTP passthrough path', async () => {
  const environment = createContextRegistryEnvironment();
  const certificates = ensureHttpProxyCertificates();
  const received: CapturedRequest[] = [];
  const upstream = await startContextHttpsOrigin(received, certificates);
  const proxy = await startHttpProxy({
    routes: [],
    anthropicOrigin: `https://127.0.0.1:${upstream.port}`,
    anthropicRejectUnauthorized: false,
  });
  const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');
  const rawBody = ` {\n  "model": "claude-native-fixture",\n  "max_tokens": 321,\n  "messages": [{"role":"user","content":"Keep this source."}],\n  "stream": true\n} `;
  const requestBody = JSON.parse(rawBody) as Record<string, unknown>;

  try {
    const secure = await bounded(
      connectMitm(proxy.port, proxy.token, certificates.caCert),
      'Native context HTTP proxy TLS handshake timed out',
    );
    const response = await bounded(
      sendContextMitmRequest(secure, requestBody, rawBody),
      'Native context HTTP passthrough response did not close',
    );

    expect(response).toContain('HTTP/1.1 200');
    expect(received).toHaveLength(1);
    expect(received[0]?.key).toBe('client-fixture-key');
    expect(received[0]?.beta).toBe('context-cache-fixture');
    expect(received[0]?.fixtureHeader).toBe('preserved-header');
    expect(received[0]?.rawBody).toBe(rawBody);
    expect(received[0]?.body).toEqual(requestBody);
    expect(applyPolicy).toHaveBeenCalledTimes(1);
  } finally {
    await proxy.close();
    await upstream.close();
    environment.close();
    vi.restoreAllMocks();
  }
}, 20_000);

it('applies request policy once while translating a public SDK route', async () => {
  const environment = createContextRegistryEnvironment();
  let received: Record<string, unknown> | undefined;
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify({
      id: 'chatcmpl-context-fixture', object: 'chat.completion', created: 1,
      model: 'translated-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'local SDK response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Local SDK upstream failed to bind');
  const route: ProxyRoute = {
    aliasId: 'leverframe:test:translated-model', realModelId: 'translated-model',
    displayName: 'Translated fixture', upstreamUrl: '', apiKey: 'fixture-provider-key',
    modelFormat: 'openai', npm: '@ai-sdk/openai-compatible',
    baseURL: `http://127.0.0.1:${address.port}/v1`, providerId: 'fixture-provider',
  };
  const proxy = await startProxyCatalog([route], route.aliasId, false);
  const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');

  try {
    const status = await postContextProxyRequest(proxy.port, proxy.token, {
      model: route.aliasId, max_tokens: 64, stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(200);
    expect(received).toMatchObject({ model: 'translated-model', messages: [{ role: 'user', content: 'hello' }] });
    expect(applyPolicy).toHaveBeenCalledTimes(1);
  } finally {
    await proxy.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    environment.close();
    vi.restoreAllMocks();
  }
});
