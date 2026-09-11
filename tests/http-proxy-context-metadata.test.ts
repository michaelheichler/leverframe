import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHttpProxy, type HttpProxyHandle } from '../src/http-proxy/server.js';
import type { ProxyRoute } from '../src/proxy-request.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('context-metadata');
const handles: HttpProxyHandle[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())); });

const route: ProxyRoute = {
  aliasId: 'leverframe:provider:model', realModelId: 'model', displayName: 'Model',
  upstreamUrl: 'https://provider.example/v1', apiKey: 'private-provider-key',
  modelFormat: 'openai', providerId: 'provider', contextWindow: 272_000, maxContextWindow: 1_048_576,
};

async function start() {
  const proxy = await startHttpProxy({
    routes: [route, { ...route, aliasId: 'leverframe:provider:unconfirmed', realModelId: 'unconfirmed', contextWindowUnconfirmed: true }],
    modelAliases: [{ name: 'atlas', routeId: route.aliasId, displayName: 'Model' }],
    adapterHandle: { port: 1, token: 'adapter-token', close: vi.fn() },
  });
  handles.push(proxy);
  return { url: `http://127.0.0.1:${proxy.port}/v1/leverframe/context-metadata`, token: proxy.token };
}

describe('proxy context metadata for Headroom', () => {
  it('advertises confirmed limits for wire identities, aliases, and context modes without credentials', async () => {
    const { url, token } = await start();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();

    expect(response.status).toBe(200);
    const { contextWindows } = JSON.parse(text);
    expect(contextWindows).toMatchObject({
      'leverframe:provider:model': 272_000,
      'leverframe:provider:model[default]': 272_000,
      'leverframe:provider:model[maximum]': 1_048_576,
      'leverframe:provider:model[1m]': 1_048_576,
      atlas: 272_000,
      'atlas[maximum]': 1_048_576,
    });
    expect(Object.keys(contextWindows).some(key => key.includes('unconfirmed'))).toBe(false);
    expect(text).not.toContain('private-provider-key');
    expect(text).not.toContain('provider.example');
    expect(text).not.toContain(token);
  });

  it('requires the current proxy token and accepts only GET', async () => {
    const { url, token } = await start();
    const unauthorized = await fetch(url, { headers: { Authorization: 'Bearer wrong' } });
    const post = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

    expect(unauthorized.status).toBe(401);
    expect(post.status).toBe(405);
  });
});
