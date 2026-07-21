import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

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
      id: 'msg-rebind',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  };
});

import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { resetLegacyMigrationForTests } from '../src/paths.js';

interface CapturedUpstreamCall {
  url: string;
  authorization: string | undefined;
  body: any;
}

function postToServer(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const handles: Array<ServerHandle | { close: () => Promise<void> }> = [];

function anthropicModel(id: string, baseUrl: string, apiKey = 'leak-if-forwarded'): ServerModelInfo {
  return {
    id,
    name: id,
    isFree: false,
    brand: 'Other',
    sourceBackend: 'zen',
    modelFormat: 'anthropic',
    baseUrl,
    apiKey,
  };
}

function openaiPassthroughModel(id: string, completionsUrl: string, apiKey = 'leak-if-forwarded'): ServerModelInfo {
  return {
    id,
    name: id,
    isFree: false,
    brand: 'Other',
    sourceBackend: 'go',
    modelFormat: 'openai',
    completionsUrl,
    apiKey,
  };
}

function openaiSdkModel(id: string, apiBaseUrl: string, apiKey = 'leak-if-forwarded'): ServerModelInfo {
  return {
    id,
    name: id,
    isFree: false,
    brand: 'OpenAI',
    providerId: 'openai',
    sourceBackend: 'openai',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai',
    apiBaseUrl,
    apiKey,
  };
}

function publicLookup(): void {
  lookupMock.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
}

function privateLookup(): void {
  lookupMock.mockImplementation(async () => [{ address: '192.168.1.5', family: 4 }]);
}

let tempHome: string;
let previousHome: string | undefined;
let previousLeverframeHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-server-rebind-'));
  previousHome = process.env['HOME'];
  previousLeverframeHome = process.env['LEVERFRAME_HOME'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
  lookupMock.mockReset();
  vi.mocked(createLanguageModel).mockClear();
  vi.mocked(generateAnthropicResponse).mockClear();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) await handle.close();
  }
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousLeverframeHome;
  resetLegacyMigrationForTests();
});

describe('server per-request URL revalidation (DNS rebinding)', () => {
  it('Anthropic passthrough: request 1 reaches upstream then request 2 is blocked before the credential is sent', async () => {
    const upstreamCalls: CapturedUpstreamCall[] = [];
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      upstreamCalls.push({
        url: typeof input === 'string' ? input : input.toString(),
        authorization: init?.headers?.Authorization,
        body: init?.body ? JSON.parse(init.body) : null,
      });
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    publicLookup();
    const rebindUrl = 'https://rebind-anthropic.example';
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'unused',
      serverPassword: null,
      catalog: createGatewayModelCatalog([anthropicModel('claude-rebind', rebindUrl)]),
    });
    handles.push(server);

    const first = await postToServer(server.port, '/anthropic/v1/messages', {
      model: 'claude-rebind',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'first' }],
      stream: false,
    });
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upstreamCalls[0]!.url).toBe(`${rebindUrl}/v1/messages`);
    expect(upstreamCalls[0]!.authorization).toBe('Bearer leak-if-forwarded');

    privateLookup();
    const second = await postToServer(server.port, '/anthropic/v1/messages', {
      model: 'claude-rebind',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'second' }],
      stream: false,
    });

    expect(second.status).toBe(400);
    expect(second.body).toMatch(/revalidation/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('direct OpenAI passthrough: request 1 reaches upstream then request 2 is blocked before the credential is sent', async () => {
    const upstreamCalls: CapturedUpstreamCall[] = [];
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      upstreamCalls.push({
        url: typeof input === 'string' ? input : input.toString(),
        authorization: init?.headers?.Authorization,
        body: init?.body ? JSON.parse(init.body) : null,
      });
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-rebind',
          object: 'chat.completion',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    publicLookup();
    const rebindUrl = 'https://rebind-openai.example';
    const completionsUrl = `${rebindUrl}/v1/chat/completions`;
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'unused',
      serverPassword: null,
      catalog: createGatewayModelCatalog([openaiPassthroughModel('openai-rebind', completionsUrl)]),
    });
    handles.push(server);

    const first = await postToServer(server.port, '/openai/v1/chat/completions', {
      model: 'openai-rebind',
      messages: [{ role: 'user', content: 'first' }],
    });
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upstreamCalls[0]!.url).toBe(completionsUrl);
    expect(upstreamCalls[0]!.authorization).toBe('Bearer leak-if-forwarded');

    privateLookup();
    const second = await postToServer(server.port, '/openai/v1/chat/completions', {
      model: 'openai-rebind',
      messages: [{ role: 'user', content: 'second' }],
    });

    expect(second.status).toBe(400);
    expect(second.body).toMatch(/revalidation/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SDK translated path with reused model cache: request 1 hits the factory once then request 2 is blocked before the cached model is reused', async () => {
    publicLookup();
    const rebindUrl = 'https://rebind-sdk.example';
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'unused',
      serverPassword: null,
      catalog: createGatewayModelCatalog([openaiSdkModel('gpt-rebind', rebindUrl)]),
    });
    handles.push(server);

    const first = await postToServer(server.port, '/anthropic/v1/messages', {
      model: 'anthropic-openai__gpt-rebind',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'first' }],
      stream: false,
    });
    expect(first.status).toBe(200);
    expect(createLanguageModel).toHaveBeenCalledTimes(1);
    const firstSpec = vi.mocked(createLanguageModel).mock.calls[0]![0] as { apiKey?: string; baseURL?: string };
    expect(firstSpec.apiKey).toBe('leak-if-forwarded');
    expect(firstSpec.baseURL).toBe(rebindUrl);
    expect(generateAnthropicResponse).toHaveBeenCalledTimes(1);

    privateLookup();
    const second = await postToServer(server.port, '/anthropic/v1/messages', {
      model: 'anthropic-openai__gpt-rebind',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'second' }],
      stream: false,
    });

    expect(second.status).toBe(400);
    expect(second.body).toMatch(/revalidation/i);
    expect(createLanguageModel).toHaveBeenCalledTimes(1);
    expect(generateAnthropicResponse).toHaveBeenCalledTimes(1);
  });
});
