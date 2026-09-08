import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { startHttpProxy } from '../src/http-proxy/server.js';
import type { ProxyRoute } from '../src/proxy.js';

vi.mock('../src/provider-catalog.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-catalog.js')>();
  return {
    ...actual,
    fetchFreshProviderCatalog: vi.fn(async () => ({
      providers: [{
        id: 'openai-oauth',
        name: 'OpenAI OAuth',
        apiKey: 'provider-key',
        models: [{
          id: 'gpt-fresh',
          name: 'Fresh model',
          family: 'gpt',
          brand: 'OpenAI',
          modelFormat: 'openai' as const,
          upstreamModelId: 'gpt-fresh',
          contextWindow: 272_000,
          maxContextWindow: 872_000,
        }],
      }],
      unavailable: [],
    })),
  };
});

const route: ProxyRoute = {
  aliasId: 'leverframe:openai-oauth:gpt-fresh',
  realModelId: 'gpt-fresh',
  displayName: 'Fresh model (OpenAI OAuth)',
  upstreamUrl: 'https://api.openai.com/v1',
  apiKey: 'provider-key',
  modelFormat: 'openai',
  providerId: 'openai-oauth',
  contextWindow: 272_000,
  maxContextWindow: 872_000,
};

function getJson(port: number, path: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path,
      headers: { Authorization: `Bearer ${token}` },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
  });
}

describe('proxy context selection callback', () => {
  const handles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (handles.length > 0) await handles.pop()!.close();
  });

  it('serves fresh context choices on the local proxy listener with its per-run token', async () => {
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: { port: 1, token: 'adapter-token', close: vi.fn() },
    });
    handles.push(proxy);

    const response = await getJson(
      proxy.port,
      '/v1/leverframe/context-selection?model=' + encodeURIComponent(route.aliasId),
      proxy.token,
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).options).toEqual([
      { mode: 'default', contextWindow: 272_000, label: 'Default (272,000)' },
      { mode: 'maximum', contextWindow: 872_000, label: 'Maximum (872,000)' },
    ]);
  });

  it('rejects a context callback without the current proxy token', async () => {
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: { port: 1, token: 'adapter-token', close: vi.fn() },
    });
    handles.push(proxy);

    const response = await getJson(
      proxy.port,
      '/v1/leverframe/context-selection?model=' + encodeURIComponent(route.aliasId),
      'wrong-token',
    );

    expect(response.status).toBe(401);
  });
});
