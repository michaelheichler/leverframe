import { describe, expect, it } from 'vitest';
import { formatHttpProxyModelLines } from '../src/http-proxy/index.js';
import type { ProxyRoute } from '../src/proxy.js';

describe('HTTP proxy startup model list', () => {
  it('does not label unavailable favorites as incompatible when no route is available', () => {
    expect(formatHttpProxyModelLines([])).toEqual(['  (no routable favorite models)']);
  });

  it('prints the available context beside the full model name', () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:openai-oauth:gpt-5.6-sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
      upstreamUrl: '',
      apiKey: 'oauth-token',
      modelFormat: 'openai',
      contextWindow: 272_000,
    };
    const lines = formatHttpProxyModelLines([route], [{
      name: 'sol',
      routeId: route.aliasId,
      displayName: route.displayName,
    }]);

    expect(lines[0]).toContain('GPT-5.6 Sol (OpenAI (ChatGPT)) (272K context)');
    expect(lines[1]).toContain('GPT-5.6 Sol (OpenAI (ChatGPT)) (272K context)');
  });
});
