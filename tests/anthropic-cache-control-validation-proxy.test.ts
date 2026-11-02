/** Because SDK proxy cache markers must fail before OAuth fetch. */
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { startProxyCatalog, type ProxyHandle, type ProxyRoute } from '../src/proxy.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-cache-marker-proxy');

let proxy: ProxyHandle | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  await proxy?.close();
  proxy = undefined;
});

function copilotRoute(): ProxyRoute {
  return {
    aliasId: 'leverframe:github-copilot:fixture-claude',
    realModelId: 'claude-cache-fixture', displayName: 'fixture Copilot Claude',
    upstreamUrl: 'https://api.githubcopilot.com/v1/messages', apiKey: 'copilot-oauth-fixture-sentinel',
    modelFormat: 'openai', npm: '@ai-sdk/anthropic', providerId: 'github-copilot', authType: 'oauth',
  };
}

function postInvalidCacheMarker(port: number, token: string): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    model: 'leverframe:github-copilot:fixture-claude', max_tokens: 8,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture', cache_control: { type: 'ephemeral', ttl: '2h' } }] }],
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

it('rejects malformed cache TTL before the Copilot upstream receives a request', async () => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    id: 'unexpected', type: 'message', role: 'assistant', model: 'fixture',
    content: [{ type: 'text', text: 'must not be generated' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  vi.stubGlobal('fetch', upstream);
  const route = copilotRoute();
  proxy = await startProxyCatalog([route], route.aliasId);

  const response = await postInvalidCacheMarker(proxy.port, proxy.token);
  const payload = JSON.parse(response.body) as { error?: { type?: string } };

  expect(response.status).toBe(400);
  expect(payload.error?.type).toBe('invalid_request_error');
  expect(upstream).not.toHaveBeenCalled();
});
