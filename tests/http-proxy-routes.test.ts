import { describe, expect, it } from 'vitest';
import { buildHttpProxyRoutes, httpProxyModelId } from '../src/http-proxy/routes.js';
import { decideHttpProxyRoute } from '../src/http-proxy/routing-decision.js';
import { buildProxyRoutesById } from '../src/http-proxy/server.js';
import { normalizeModelAliases } from '../src/model-aliases.js';
import type { LocalProvider } from '../src/types.js';

const providers: LocalProvider[] = [
  {
    id: 'groq',
    name: 'Groq Cloud',
    apiKey: 'groq-key',
    models: [{
      id: 'llama-3.3-70b',
      upstreamModelId: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B',
      family: 'llama',
      brand: 'Meta',
      modelFormat: 'openai',
      npm: '@ai-sdk/groq',
      contextWindow: 1_000_000,
    }],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiKey: 'anthropic-key',
    models: [{
      id: 'claude-sonnet-4-6',
      upstreamModelId: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      family: 'claude',
      brand: 'Claude',
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      baseUrl: 'https://api.anthropic.com',
    }],
  },
];

describe('HTTP proxy routes', () => {
  it('uses stable provider-prefixed names and includes only AI SDK favorites', () => {
    const result = buildHttpProxyRoutes(providers, [
      { providerId: 'groq', modelId: 'llama-3.3-70b' },
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      { providerId: 'missing', modelId: 'gone' },
    ]);

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({
      aliasId: 'leverframe:groq:llama-3.3-70b[1m]',
      realModelId: 'llama-3.3-70b-versatile',
      npm: '@ai-sdk/groq',
      apiKey: 'groq-key',
    });
    expect(result.unsupported).toEqual([{ providerId: 'anthropic', modelId: 'claude-sonnet-4-6' }]);
    expect(result.unavailable).toEqual([{ providerId: 'missing', modelId: 'gone' }]);
  });

  it('does not create a route when the provider credential is empty', () => {
    const noKey = [{ ...providers[0]!, apiKey: '' }];
    const result = buildHttpProxyRoutes(noKey, [{ providerId: 'groq', modelId: 'llama-3.3-70b' }]);
    expect(result.routes).toEqual([]);
    expect(result.unavailable).toHaveLength(1);
  });

  it('routes Anthropic-format models from non-Anthropic providers', () => {
    const go: LocalProvider = {
      id: 'opencode-go',
      name: 'OpenCode Go',
      apiKey: 'go-key',
      models: [{
        id: 'qwen3.7-plus',
        upstreamModelId: 'qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        family: 'qwen',
        brand: 'Qwen',
        modelFormat: 'anthropic',
        npm: '@ai-sdk/anthropic',
        baseUrl: 'https://opencode.ai/zen/go',
        contextWindow: 1_000_000,
      }],
    };

    const result = buildHttpProxyRoutes([go], [{ providerId: 'opencode-go', modelId: 'qwen3.7-plus' }]);
    expect(result.unsupported).toEqual([]);
    expect(result.routes[0]).toMatchObject({
      aliasId: 'leverframe:opencode-go:qwen3.7-plus[1m]',
      modelFormat: 'anthropic',
      upstreamUrl: 'https://opencode.ai/zen/go',
    });
  });

  it('formats the exact freeform Claude model id', () => {
    expect(httpProxyModelId('openrouter', 'deepseek/deepseek-v3')).toBe('leverframe:openrouter:deepseek/deepseek-v3');
  });

  it('resolves short aliases only when they target available HTTP-proxy favorites', () => {
    const result = buildHttpProxyRoutes(
      providers,
      [{ providerId: 'groq', modelId: 'llama-3.3-70b' }],
      [
        { name: 'llama', providerId: 'groq', modelId: 'llama-3.3-70b' },
        { name: 'missing', providerId: 'groq', modelId: 'gone' },
        { name: 'bad:name', providerId: 'groq', modelId: 'llama-3.3-70b' },
      ],
    );

    expect(result.aliases).toEqual([{
      name: 'llama',
      routeId: 'leverframe:groq:llama-3.3-70b[1m]',
      displayName: 'Llama 3.3 70B (Groq Cloud)',
    }]);
    expect(result.unavailableAliases).toEqual([
      { name: 'missing', providerId: 'groq', modelId: 'gone' },
      { name: 'bad:name', providerId: 'groq', modelId: 'llama-3.3-70b' },
    ]);
  });

  it('routes Claude lowercase output for a legacy mixed-case Kimi alias', () => {
    const kimi: LocalProvider = {
      id: 'kimi',
      name: 'Kimi (Coding Plan)',
      apiKey: 'kimi-key',
      models: [{
        id: 'k3',
        upstreamModelId: 'k3',
        name: 'Kimi K3',
        family: 'kimi',
        brand: 'Kimi',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai-compatible',
        contextWindow: 1_048_576,
      }],
    };
    const aliases = normalizeModelAliases([
      { name: 'Kimi3-KCP', providerId: 'kimi', modelId: 'k3' },
    ]);
    const loaded = buildHttpProxyRoutes(
      [kimi],
      [{ providerId: 'kimi', modelId: 'k3' }],
      aliases,
    );
    const routesById = buildProxyRoutesById(loaded.routes, loaded.aliases);

    const translated = decideHttpProxyRoute({
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ model: 'kimi3-kcp' })),
      routesById,
      hasAdapter: true,
    });
    const unknown = decideHttpProxyRoute({
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ model: 'unknown-kimi-alias' })),
      routesById,
      hasAdapter: true,
    });

    expect(loaded.aliases[0]?.name).toBe('kimi3-kcp');
    expect(translated.action).toBe('translated');
    if (translated.action === 'translated') expect(translated.route.providerId).toBe('kimi');
    expect(unknown.action).toBe('passthrough-messages');
  });
});
