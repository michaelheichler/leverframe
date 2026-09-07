import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-server-router');

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: unknown) => ({ spec })),
  };
});

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    resolveProviderCredential: vi.fn(actual.resolveProviderCredential),
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

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
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
  urls: Partial<Pick<ServerModelInfo, 'baseUrl' | 'completionsUrl' | 'apiKey'>> = {},
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

});
