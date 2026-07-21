import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { generateOpenAiResponse } from '../src/openai-adapter.js';
import { revalidateCustomEndpointUrl } from '../src/registry/url-security.js';

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: unknown) => ({ spec })),
  };
});

vi.mock('../src/sdk-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'sdk ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  };
});

vi.mock('../src/openai-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/openai-adapter.js')>();
  return {
    ...actual,
    generateOpenAiResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: modelId,
      choices: [{ message: { content: 'openai sdk ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })),
  };
});

vi.mock('../src/registry/url-security.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/url-security.js')>();
  return {
    ...actual,
    revalidateCustomEndpointUrl: vi.fn(actual.revalidateCustomEndpointUrl),
  };
});

interface UpstreamRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: any;
}

async function readRequestBody(req: Parameters<typeof createServer>[0] extends (req: infer R, res: any) => any ? R : never): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : null;
}

async function startUpstream(responseBody: any): Promise<{ baseUrl: string; requests: UpstreamRequest[]; close: () => Promise<void> }> {
  const requests: UpstreamRequest[] = [];
  const server = createServer(async (req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization,
      body: await readRequestBody(req),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing upstream address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

const handles: Array<ServerHandle | { close: () => Promise<void> }> = [];

function model(
  id: string,
  modelFormat: ServerModelInfo['modelFormat'],
  sourceBackend: ServerModelInfo['sourceBackend'],
  urls: { baseUrl?: string; completionsUrl?: string } = {},
): ServerModelInfo {
  return {
    id,
    name: id,
    isFree: false,
    brand: 'Other',
    sourceBackend,
    modelFormat,
    ...urls,
  };
}

function defaultCatalog(upstreamBaseUrl: string) {
  return createGatewayModelCatalog([
    model('claude-native', 'anthropic', 'zen', { baseUrl: upstreamBaseUrl }),
    model('openai-format', 'openai', 'go', { completionsUrl: `${upstreamBaseUrl}/v1/chat/completions` }),
    model('bad-format', 'unsupported', 'zen'),
  ]);
}

async function startTestServer(options: Partial<Parameters<typeof startServer>[0]> = {}): Promise<ServerHandle> {
  const upstream = await startUpstream({
    id: 'chatcmpl-test',
    choices: [{ message: { content: 'upstream ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  });
  handles.push(upstream);

  const handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    apiKey: 'real-opencode-key',
    serverPassword: null,
    catalog: defaultCatalog(upstream.baseUrl),
    ...options,
  });
  handles.push(handle);
  return handle;
}

async function closeHandle(handle: ServerHandle | { close: () => Promise<void> }): Promise<void> {
  await handle.close();
}

afterEach(async () => {
  vi.mocked(createLanguageModel).mockClear();
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) await closeHandle(handle);
  }
});

describe('server router', () => {
  it('logs inference routing metadata without request content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-server-audit-'));
    const inferenceLogPath = join(dir, 'requests.jsonl');
    const auditUpstream = await startUpstream({
      id: 'msg-audit',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    });
    handles.push(auditUpstream);
    const auditCatalog = createGatewayModelCatalog([
      model('claude-native', 'anthropic', 'zen', { baseUrl: auditUpstream.baseUrl }),
      {
        id: 'llama-test',
        name: 'Llama Test',
        isFree: false,
        brand: 'Meta',
        providerId: 'groq',
        sourceBackend: 'groq',
        modelFormat: 'openai',
        npm: '@ai-sdk/groq',
        apiKey: 'groq-key',
      },
    ]);

    try {
      const server = await startTestServer({ catalog: auditCatalog, inferenceLogPath });
      for (const request of [
        { model: 'claude-native', output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'private prompt' }] },
        { model: 'anthropic-groq__llama-test', output_config: { effort: 'medium' }, messages: [{ role: 'user', content: 'another private prompt' }] },
      ]) {
        const response = await fetch(`${server.url}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
        expect(response.status).toBe(200);
      }

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toEqual([
        expect.objectContaining({ modelId: 'claude-native', effort: 'high', provider: 'zen', route: 'passthrough' }),
        expect.objectContaining({ modelId: 'anthropic-groq__llama-test', effort: 'medium', provider: 'groq', route: 'translated' }),
      ]);
      expect(readFileSync(inferenceLogPath, 'utf8')).not.toContain('private prompt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves health and model list endpoints', async () => {
    const server = await startTestServer();

    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const models = await fetch(`${server.url}/models`);
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-native' }),
        expect.objectContaining({ id: 'openai-format' }),
      ]),
    });

    const anthropic = await fetch(`${server.url}/anthropic/v1/models`);
    expect(anthropic.status).toBe(200);
    expect(await anthropic.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-native' }),
        expect.objectContaining({ id: 'anthropic-go__openai-format' }),
      ]),
    });

    const openai = await fetch(`${server.url}/openai/v1/models`);
    expect(openai.status).toBe(200);
    expect(await openai.json()).toMatchObject({ object: 'list' });
  });

  it('returns 401 for protected endpoints when password is missing or wrong', async () => {
    const server = await startTestServer({ serverPassword: 'secret' });

    const missing = await fetch(`${server.url}/openai/v1/models`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { message: 'Unauthorized' } });

    const wrong = await fetch(`${server.url}/openai/v1/models`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.status).toBe(401);

    const right = await fetch(`${server.url}/openai/v1/models`, {
      headers: { 'x-api-key': 'secret' },
    });
    expect(right.status).toBe(200);
  });

  it('rejects a per-start token guess on inference routes', async () => {
    const server = await startTestServer({ serverPassword: 'per-start-secret' });
    const guess = await fetch(`${server.url}/openai/v1/models`, {
      headers: { authorization: 'Bearer per-start-secre' },
    });
    expect(guess.status).toBe(401);
    const ok = await fetch(`${server.url}/openai/v1/models`, {
      headers: { authorization: 'Bearer per-start-secret' },
    });
    expect(ok.status).toBe(200);
  });

  it('health stays open without auth even when a password is set', async () => {
    const server = await startTestServer({ serverPassword: 'secret' });
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  it('enforceLocalHost rejects DNS-rebinding and external Host headers', async () => {
    const server = await startTestServer({ enforceLocalHost: true });
    const port = server.port;
    const net = await import('node:net');
    const sendHost = async (host: string): Promise<number> => {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write('GET /models HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n');
      const response = await new Promise<string>(resolve => {
        let buf = '';
        socket.on('data', chunk => { buf += chunk.toString(); });
        socket.once('close', () => resolve(buf));
      });
      socket.destroy();
      const match = /^HTTP\/1\.1 (\d+)/.exec(response);
      return match ? Number(match[1]) : 0;
    };
    expect(await sendHost('127.0.0.1')).toBe(200);
    expect(await sendHost('localhost:17645')).toBe(200);
    expect(await sendHost('victim.example')).toBe(403);
    expect(await sendHost('10.0.0.5')).toBe(403);
  });

  it('enforceLocalHost leaves /health reachable for loopback but blocks external Hosts', async () => {
    const server = await startTestServer({ enforceLocalHost: true });
    const port = server.port;
    const health = await fetch('http://127.0.0.1:' + port + '/health');
    expect(health.status).toBe(200);
    const net = await import('node:net');
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.write('GET /health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    const response = await new Promise<string>(resolve => {
      let buf = '';
      socket.on('data', chunk => { buf += chunk.toString(); });
      socket.once('close', () => resolve(buf));
    });
    socket.destroy();
    expect(response.startsWith('HTTP/1.1 403')).toBe(true);
  });

  it('enforceLocalHost raw-socket variants gate before /health and auth', async () => {
    const server = await startTestServer({ enforceLocalHost: true, serverPassword: 'secret' });
    const port = server.port;
    const net = await import('node:net');

    const send = async (rawRequest: string): Promise<{ status: number; body: string }> => {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(rawRequest);
      const response = await new Promise<string>(resolve => {
        let buf = '';
        socket.on('data', chunk => { buf += chunk.toString(); });
        socket.once('close', () => resolve(buf));
      });
      socket.destroy();
      const match = /^HTTP\/1\.1 (\d+)/.exec(response);
      const status = match ? Number(match[1]) : 0;
      const bodyStart = response.indexOf('\r\n\r\n');
      const body = bodyStart >= 0 ? response.slice(bodyStart + 4) : '';
      return { status, body };
    };

    expect((await send('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')).status).toBe(200);
    expect((await send('GET /health HTTP/1.1\r\nHost: 127.0.0.1:17645\r\nConnection: close\r\n\r\n')).status).toBe(200);
    expect((await send('GET /health HTTP/1.1\r\nHost: [::1]:17645\r\nConnection: close\r\n\r\n')).status).toBe(200);

    expect((await send('GET /health HTTP/1.1\r\nHost: localhost\r\nHost: evil.example\r\nConnection: close\r\n\r\n')).status).toBe(403);
    expect((await send('GET /health HTTP/1.1\r\nHost: localhost\r\nHost: localhost\r\nConnection: close\r\n\r\n')).status).toBe(403);
    // Missing Host is rejected by Node's HTTP parser as 400 before the gate.
    const missingHost = await send('GET /health HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect(missingHost.status).toBeGreaterThanOrEqual(400);
    expect(missingHost.status).toBeLessThan(500);

    expect((await send('GET /health HTTP/1.1\r\nHost: [::1\r\nConnection: close\r\n\r\n')).status).toBe(403);
    expect((await send('GET /health HTTP/1.1\r\nHost: localhost.\r\nConnection: close\r\n\r\n')).status).toBe(403);
    expect((await send('GET /health HTTP/1.1\r\nHost: ::1\r\nConnection: close\r\n\r\n')).status).toBe(403);
    expect((await send('GET /health HTTP/1.1\r\nHost: localhost:99999\r\nConnection: close\r\n\r\n')).status).toBe(403);
    expect((await send('GET /health HTTP/1.1\r\nHost: localhost:0\r\nConnection: close\r\n\r\n')).status).toBe(403);
    expect((await send('GET /health HTTP/1.1\r\nHost: user@localhost\r\nConnection: close\r\n\r\n')).status).toBe(403);

    expect((await send('GET http://victim.example/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')).status).toBe(403);
    expect((await send('GET http://127.0.0.1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')).status).toBe(403);

    const ext = await send('GET /openai/v1/models HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    expect(ext.status).toBe(403);
    expect(ext.body).not.toContain('Unauthorized');

    expect((await send('GET /openai/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')).status).toBe(401);
    expect((await send('GET /openai/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nx-api-key: secret\r\nConnection: close\r\n\r\n')).status).toBe(200);
  });

  it('forwards Anthropic-native messages to the backend v1/messages endpoint with the real API key', async () => {
    const upstream = await startUpstream({
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native ok' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('claude-native', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
      ]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'msg-test' });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/messages',
      authorization: 'Bearer real-opencode-key',
      body: { model: 'claude-native', messages: [{ role: 'user', content: 'hi' }] },
    });
  });

  it('rejects Anthropic messages for OpenAI-format models without an SDK provider', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-format',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('No SDK provider') },
    });
  });

  it('revalidates an Anthropic passthrough baseUrl at request time and blocks on DNS rebinding', async () => {
    const { revalidateCustomEndpointUrl } = await import('../src/registry/url-security.js');
    const rebindUrl = 'https://rebind.anthropic.example';
    const rebindCatalog = createGatewayModelCatalog([
      model('claude-rebind', 'anthropic', 'zen', { baseUrl: rebindUrl, apiKey: 'leak-if-forwarded' }),
    ]);
    vi.mocked(revalidateCustomEndpointUrl).mockResolvedValueOnce({
      ok: false,
      error: 'URL resolves to a private or restricted network address.',
      hint: 'Use a public HTTPS endpoint.',
    });

    const upstream = await startUpstream({ id: 'should-not-reach', content: [] });
    handles.push(upstream);
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'unused',
      serverPassword: null,
      catalog: rebindCatalog,
    });
    handles.push(server);

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-rebind',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toMatch(/private|restricted/i);
    expect(upstream.requests).toHaveLength(0);
    expect(revalidateCustomEndpointUrl).toHaveBeenCalledWith(rebindUrl, expect.objectContaining({ allowInsecureLocal: false }));
    vi.mocked(revalidateCustomEndpointUrl).mockRestore();
  });

  it('returns Anthropic prompt-too-long shape for a translated context overflow', async () => {
    const contextCatalog = createGatewayModelCatalog([{
      id: 'small-context',
      name: 'Small Context',
      isFree: false,
      brand: 'Test',
      providerId: 'test-provider',
      sourceBackend: 'test-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiKey: 'provider-key',
      contextWindow: 10,
    }]);
    vi.mocked(generateAnthropicResponse).mockRejectedValueOnce({
      statusCode: 400,
      data: {
        error: {
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window of this model.',
        },
      },
    });
    const server = await startTestServer({ catalog: contextCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-test-provider__small-context',
        messages: [{ role: 'user', content: 'This prompt is too long.' }],
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as {
      type: string;
      error: { type: string; message: string };
      request_id: string;
    };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/^prompt is too long: \d+ tokens > 10 maximum$/);
    expect(body.request_id).toEqual(expect.any(String));
  });

  it('forces internal streaming for non-streaming requests on OpenAI OAuth routes', async () => {
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'gpt-oauth',
      name: 'GPT OAuth',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai-oauth',
      sourceBackend: 'openai-oauth',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'oauth',
      apiKey: 'oauth-access-token',
    }]);
    const server = await startTestServer({ catalog: oauthCatalog });

    const messagesResponse = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai-oauth__gpt-oauth',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(messagesResponse.status).toBe(200);
    expect(vi.mocked(generateAnthropicResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: true }),
    );

    const chatResponse = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oauth',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(chatResponse.status).toBe(200);
    expect(vi.mocked(generateOpenAiResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: true }),
    );
  });

  it('does not force streaming for non-streaming requests on API-key routes', async () => {
    const apiKeyCatalog = createGatewayModelCatalog([{
      id: 'gpt-api',
      name: 'GPT API',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'api',
      apiKey: 'sk-test',
    }]);
    const server = await startTestServer({ catalog: apiKeyCatalog });

    const messagesResponse = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai__gpt-api',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(messagesResponse.status).toBe(200);
    expect(vi.mocked(generateAnthropicResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: false }),
    );

    const chatResponse = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-api',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(chatResponse.status).toBe(200);
    expect(vi.mocked(generateOpenAiResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: false }),
    );
  });

  it('forwards OpenAI chat completions for OpenAI-format models unchanged', async () => {
    const upstream = await startUpstream({
      id: 'chatcmpl-test',
      choices: [{ message: { content: 'openai ok' }, finish_reason: 'stop' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('openai-format', 'openai', 'go', { completionsUrl: `${upstream.baseUrl}/v1/chat/completions` }),
      ]),
    });

    const body = { model: 'openai-format', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 };
    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test' });
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: 'Bearer real-opencode-key',
      body,
    });
  });

  it('caches SDK language models per provider-qualified route, not just raw model id', async () => {
    const duplicateCatalog = createGatewayModelCatalog([
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openai',
        providerLabel: 'OpenAI',
        sourceBackend: 'openai',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        apiKey: 'openai-key',
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o via OpenRouter',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openrouter',
        providerLabel: 'OpenRouter',
        sourceBackend: 'openrouter',
        modelFormat: 'openai',
        npm: '@openrouter/ai-sdk-provider',
        apiKey: 'openrouter-key',
      },
    ]);
    const server = await startTestServer({ catalog: duplicateCatalog });

    for (const modelId of ['anthropic-openai__gpt-4o', 'anthropic-openrouter__gpt-4o']) {
      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
    }

    expect(vi.mocked(createLanguageModel)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createLanguageModel).mock.calls.map(call => (call[0] as any).providerId)).toEqual([
      'openai',
      'openrouter',
    ]);
  });

  it('exposes SDK-only registry models through OpenAI chat completions', async () => {
    const sdkOnlyCatalog = createGatewayModelCatalog([{
      id: 'gpt-5',
      name: 'GPT-5',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      providerLabel: 'OpenAI',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
    }]);
    const server = await startTestServer({ catalog: sdkOnlyCatalog });

    const models = await fetch(`${server.url}/openai/v1/models`);
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({
      object: 'list',
      data: [
        expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
      ],
    });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', choices: [{ message: { content: 'openai sdk ok' } }] });
  });

  it('revalidates the provider base URL before direct OpenAI chat completions', async () => {
    vi.mocked(revalidateCustomEndpointUrl).mockResolvedValueOnce({ ok: false, error: 'blocked for test' });
    const catalog = createGatewayModelCatalog([{
      id: 'gpt-direct',
      name: 'GPT Direct',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      providerLabel: 'OpenAI',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      apiBaseUrl: 'https://api.openai.com/v1',
      completionsUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'openai-key',
    }]);
    const server = await startTestServer({ catalog });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-direct', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(400);
    expect(revalidateCustomEndpointUrl).toHaveBeenCalledWith('https://api.openai.com/v1', {
      allowInsecureLocal: false,
    });
  });

  it('translates OpenAI requests for Anthropic-native models', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native', messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', choices: [{ message: { content: 'openai sdk ok' } }] });
  });

  it('rejects unsupported model formats', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bad-format', messages: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('Unsupported model format') },
    });
  });

  describe('saved alias and masked-id request resolution', () => {
    const lunaModel: ServerModelInfo = {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai-oauth',
      providerLabel: 'OpenAI (ChatGPT)',
      sourceBackend: 'openai-oauth',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiKey: 'oauth-token',
    };
    const gateway = { maskGatewayIds: true as const };
    const aliases = [{ name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }];

    async function startAliasServer(): Promise<ServerHandle> {
      return startTestServer({
        catalog: createGatewayModelCatalog([lunaModel], gateway, aliases),
        gateway,
        aliasNames: new Set(aliases.map(alias => alias.name)),
      });
    }

    it('resolves a bare saved alias and echoes it back verbatim in the response model', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'luna', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(response.status).toBe(200);
      // Echo invariant: the alias the client sent, not the canonical/display id.
      expect(await response.json()).toMatchObject({ id: 'msg-test', model: 'luna' });
    });

    it('resolves masked and canonical leverframe ids when masking is on', async () => {
      const server = await startAliasServer();

      for (const requestId of [
        'anthropic-htuao-ianepo__anul-6.5-tpg', // masked form of anthropic-openai-oauth__gpt-5.6-luna
        'leverframe:openai-oauth:gpt-5.6-luna',
      ]) {
        const response = await fetch(`${server.url}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: requestId, messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(response.status, requestId).toBe(200);
      }
    });

    it('resolves a saved alias on the OpenAI chat completions endpoint too', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'luna', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', model: 'luna' });
    });

    it('still rejects unknown model ids with 400', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nova', messages: [] }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { message: 'Unknown model: nova' } });
    });

    it('does not advertise alias names in the discovery model list', async () => {
      const server = await startAliasServer();

      const listing = await fetch(`${server.url}/anthropic/v1/models`);
      expect(listing.status).toBe(200);
      const payload = await listing.json() as { data: Array<{ id: string }> };
      expect(payload.data.map(entry => entry.id)).toEqual(['anthropic-htuao-ianepo__anul-6.5-tpg']);
    });
  });
});
