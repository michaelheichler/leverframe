import { afterEach, expect, it, vi } from 'vitest';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getProvidersPath } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';

const zenEndpoint = 'https://opencode.ai/inference/openai/v1/chat/completions';
const modelId = 'zen-free-fixture';
const firstSession = '11111111-1111-4111-8111-111111111111';
const secondSession = '22222222-2222-4222-8222-222222222222';
const originalFetch = globalThis.fetch;
let closeServer: (() => Promise<void>) | undefined;

function saveAnonymousAccounts(): void {
  const fixtureHome = process.env['LEVERFRAME_HOME']!;
  const relativePath = relative(resolve(fixtureHome), resolve(getProvidersPath()));
  expect(isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)).toBe(false);
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'opencode-zen', templateId: 'opencode-zen', name: 'OpenCode Zen', enabled: true,
    authType: 'none', authRef: 'none:anonymous', api: {}, addedAt: '2026-11-04T00:00:00.000Z',
    accounts: [
      { id: 'first', name: 'First', tag: 'ONE', authRef: 'none:anonymous', enabled: true },
      { id: 'second', name: 'Second', tag: 'TWO', authRef: 'none:anonymous', enabled: true },
    ],
  }] });
}

async function startZenServer() {
  saveAnonymousAccounts();
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'gateway-fixture-key', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: modelId, name: 'Zen free fixture', isFree: true, brand: 'Fixture', sourceBackend: 'opencode-zen',
      modelFormat: 'openai', providerId: 'opencode-zen', upstreamModelId: 'big-pickle',
      authType: 'none', apiKey: 'public', npm: '@ai-sdk/openai-compatible',
      apiBaseUrl: 'https://opencode.ai/inference/openai/v1', completionsUrl: zenEndpoint,
    }]),
  });
  closeServer = server.close;
  return server;
}

function interceptZen(status = 200) {
  const calls: Array<{ authorization: string | null; userAgent: string | null; session: string | null }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
    expect(url).toBe(zenEndpoint);
    const headers = new Headers(init?.headers);
    calls.push({ authorization: headers.get('authorization'), userAgent: headers.get('user-agent'),
      session: headers.get('x-opencode-session') });
    if (status === 429) return Response.json({ error: {
      type: 'FreeUsageLimitError', message: 'Free model limit reached.',
    } }, { status, headers: { 'Retry-After': '14904' } });
    return Response.json({
      id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: 'big-pickle',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  return calls;
}

function postSession(url: string, session: string): Promise<Response> {
  return originalFetch(`${url}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Claude-Code-Session-Id': session },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply OK' }] }),
  });
}

function postAnthropicSession(url: string, session: string): Promise<Response> {
  return originalFetch(`${url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Claude-Code-Session-Id': session },
    body: JSON.stringify({ model: modelId, max_tokens: 20, messages: [{ role: 'user', content: 'Reply OK' }] }),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeServer?.();
  closeServer = undefined;
});

it('sends isolated OpenCode session identity through the local OpenAI server route', async () => {
  const calls = interceptZen();
  const server = await startZenServer();

  const first = await postSession(server.url, firstSession);
  const second = await postSession(server.url, secondSession);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(calls).toEqual([
    { authorization: 'Bearer public', userAgent: expect.stringMatching(/^opencode\//), session: firstSession },
    { authorization: 'Bearer public', userAgent: expect.stringMatching(/^opencode\//), session: secondSession },
  ]);
});

it('does not fail over a Zen free tier limit response to another anonymous account', async () => {
  const calls = interceptZen(429);
  const server = await startZenServer();

  const response = await postSession(server.url, firstSession);

  expect(response.status).toBe(429);
  expect(calls).toEqual([
    { authorization: 'Bearer public', userAgent: expect.stringMatching(/^opencode\//), session: firstSession },
  ]);
});

it('does not fail over a Zen free tier limit response through Claude Messages', async () => {
  const calls = interceptZen(429);
  const server = await startZenServer();

  const response = await postAnthropicSession(server.url, firstSession);

  expect(response.status).toBe(429);
  expect(calls).toEqual([
    { authorization: 'Bearer public', userAgent: expect.stringMatching(/^opencode\//), session: firstSession },
  ]);
});
