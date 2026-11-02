import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { claudeSessionPromptCacheKey } from '../src/sdk-adapter.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-codex-session-proxy');

vi.mock('../src/registry/url-security.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/registry/url-security.js')>()),
  revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true as const, normalizedUrl: url })),
}));

let closeProxy: (() => Promise<void> | void) | undefined;
let providerFetch: ReturnType<typeof vi.fn> | undefined;

afterEach(async () => {
  await closeProxy?.();
  closeProxy = undefined;
  vi.unstubAllGlobals();
  providerFetch = undefined;
});

function route(): ProxyRoute {
  return {
    aliasId: 'anthropic-openai-oauth__gpt-session-fixture', realModelId: 'gpt-session-fixture',
    displayName: 'GPT Session Fixture', upstreamUrl: 'https://provider.invalid', apiKey: 'fixture-access-token',
    modelFormat: 'openai', providerId: 'openai-oauth', authType: 'oauth',
    oauthAccountId: 'fixture-account-id', npm: '@ai-sdk/openai',
  };
}

function postMessages(port: number, token: string, body: unknown): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    } }, response => {
      response.resume();
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

it('passes translated session affinity through the SDK proxy route', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const item = {
    id: 'fixture-output', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'fixture response', annotations: [] }],
  };
  const upstreamResponse = {
    id: 'fixture-response', status: 'completed', output: [item],
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 },
  };
  const events = [
    { type: 'response.created', response: { id: upstreamResponse.id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture response' },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: upstreamResponse },
  ];
  const stream = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  vi.stubGlobal('fetch', providerFetch);
  const proxy = await startProxyCatalog([route()], 'anthropic-openai-oauth__gpt-session-fixture');
  closeProxy = proxy.close;

  const response = await postMessages(proxy.port, proxy.token, {
    model: 'anthropic-openai-oauth__gpt-session-fixture',
    metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    messages: [{ role: 'user', content: 'fixture request' }],
  });

  expect(response.status, response.body).toBe(200);
  expect(providerFetch).toHaveBeenCalledOnce();
  const [, init] = providerFetch!.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
  const headers = new Headers(init.headers);
  const upstreamBody = JSON.parse(String(init.body)) as Record<string, unknown>;
  expect(upstreamBody.prompt_cache_key).toBe(claudeSessionPromptCacheKey(sessionId));
  expect(headers.get('session-id')).toBe(claudeSessionPromptCacheKey(sessionId));
  expect(headers.get('session-id')).not.toContain(sessionId);
  expect(headers.get('chatgpt-account-id')).toBe('fixture-account-id');
  expect(headers.get('authorization')).toMatch(/^Bearer /);
});
