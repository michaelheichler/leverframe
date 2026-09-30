import { describe, it, expect, vi } from 'vitest';
import { thinkingProviderOptions } from '../src/provider-factory.js';
import { CODEX_RESPONSES_LITE_VERSION } from '../src/constants.js';
import { OPENAI_OAUTH_ASTRA_MODEL } from './fixtures/openai-oauth-astra-metadata.js';

vi.mock('../src/registry/url-security.js', () => ({
  isHardcodedTrustedHost: (url: string) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'api.openai.com' || host === 'api.anthropic.com' || host === 'chatgpt.com';
    } catch {
      return false;
    }
  },
  revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
}));

describe('createLanguageModel', () => {
  it('prefers the current OpenAI OAuth token account claim over stored metadata', async () => {
    vi.resetModules();
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));

    const header = Buffer.from('{}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'acct-123' })).toString('base64url');
    const accessToken = `${header}.${payload}.sig`;

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.5',
      apiKey: accessToken,
      authType: 'oauth',
      oauthAccountId: 'stored-acct-456',
      preferWebSockets: true,
    });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: accessToken,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      fetch: expect.any(Function),
      headers: {
        'ChatGPT-Account-Id': 'acct-123',
        originator: 'leverframe',
      },
    });
    expect(responses).toHaveBeenCalledWith('gpt-5.5');
    vi.doUnmock('@ai-sdk/openai');
  });

  it('uses the HTTP Responses transport when discovery does not prefer WebSockets', async () => {
    vi.resetModules();
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-6-astra',
      apiKey: 'opaque-access-token',
      authType: 'oauth',
      preferWebSockets: false,
    });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'opaque-access-token',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      headers: { originator: 'leverframe' },
    });
    expect(responses).toHaveBeenCalledWith('gpt-6-astra');
    vi.doUnmock('@ai-sdk/openai');
  });

});

describe('OpenAI OAuth version and account', () => {
  it('keeps Responses Lite above an older model minimum', async () => {
    vi.resetModules();
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-6-astra',
      apiKey: 'opaque-access-token',
      authType: 'oauth',
      useResponsesLite: true,
      minimalClientVersion: OPENAI_OAUTH_ASTRA_MODEL.minimal_client_version,
    });

    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      headers: {
        originator: 'leverframe',
        version: CODEX_RESPONSES_LITE_VERSION,
        'x-openai-internal-codex-responses-lite': 'true',
      },
    }));
    expect(responses).toHaveBeenCalledWith('gpt-6-astra');
    vi.doUnmock('@ai-sdk/openai');
  });

  it('falls back to the stored OpenAI account id when the current token has no account claim', async () => {
    vi.resetModules();
    const responses = vi.fn((modelId: string) => ({
      modelId,
      provider: 'openai-responses',
    }));
    const chat = vi.fn((modelId: string) => ({
      modelId,
      provider: 'openai-chat',
    }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.5',
      apiKey: 'opaque-access-token',
      authType: 'oauth',
      oauthAccountId: 'stored-acct-456',
    });

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'ChatGPT-Account-Id': 'stored-acct-456',
        }),
      }),
    );
    vi.doUnmock('@ai-sdk/openai');
  });

});

describe('Anthropic provider identity', () => {
  it('ignores discovery baseURL for @ai-sdk/anthropic (SDK default includes /v1)', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId, provider: 'anthropic' }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
    });

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(createAnthropic).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.anthropic.com' }),
    );
    vi.doUnmock('@ai-sdk/anthropic');
  });

  it('normalizes custom anthropic baseURL to include /v1', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.com',
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.com/v1',
    });
    vi.doUnmock('@ai-sdk/anthropic');
  });

  it('routes Claude Code Anthropic OAuth through Bearer auth with compatibility headers', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId, provider: 'anthropic-oauth' }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'oauth-token',
      authType: 'oauth',
      providerId: 'claude-code',
      oauthAccountId: '11111111-1111-4111-8111-111111111111',
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      authToken: 'oauth-token',
      headers: expect.objectContaining({
        'User-Agent': 'claude-cli/2.1.195 (external, cli)',
        'x-app': 'cli',
        'X-Claude-Code-Session-Id': expect.any(String),
      }),
    });
    expect(createAnthropic).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'oauth-token' }),
    );
    expect(anthropicFactory).toHaveBeenCalledWith('claude-sonnet-4-6');
    vi.doUnmock('@ai-sdk/anthropic');
  });

});

describe('custom provider headers', () => {
  it('forwards custom headers for openai-compatible custom endpoints', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'glm-5.2',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      providerId: 'custom-zai',
      headers: { 'X-Plan': 'coding' },
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'custom-zai',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      includeUsage: true,
      headers: { 'X-Plan': 'coding' },
    });
    vi.doUnmock('@ai-sdk/openai-compatible');
  });

  it('omits apiKey for anonymous openai-compatible providers', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'tencent/hy3:free',
      apiKey: '',
      baseURL: 'https://api.kilo.ai/api/gateway',
      providerId: 'kilo',
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'kilo',
      baseURL: 'https://api.kilo.ai/api/gateway',
      includeUsage: true,
    });
    vi.doUnmock('@ai-sdk/openai-compatible');
  });

  it('merges custom headers into a non-OAuth custom anthropic endpoint', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId }));
    const createAnthropic = vi.fn(() => anthropicFactory);
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/anthropic',
      modelId: 'glm-5.2',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/anthropic',
      headers: { 'X-Plan': 'coding' },
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/anthropic/v1',
      headers: { 'X-Plan': 'coding' },
    });
    vi.doUnmock('@ai-sdk/anthropic');
  });

});

describe('provider endpoint revalidation', () => {
  it('rejects a custom baseURL that fails DNS rebinding revalidation before any upstream call', async () => {
    const { revalidateCustomEndpointUrl } = await import('../src/registry/url-security.js');
    vi.mocked(revalidateCustomEndpointUrl).mockResolvedValueOnce({
      ok: false,
      error: 'URL resolves to a private or restricted network address.',
      hint: 'Use a public HTTPS endpoint.',
    });

    const anthropicFactory = vi.fn(() => ({ provider: 'should-not-reach' }));
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic: () => anthropicFactory }));

    const { createLanguageModel: create, EndpointUrlValidationError } = await import('../src/provider-factory.js');
    await expect(create({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'sk-test',
      baseURL: 'https://rebind.example.com/v1',
    })).rejects.toBeInstanceOf(EndpointUrlValidationError);
    expect(anthropicFactory).not.toHaveBeenCalled();
    vi.doUnmock('@ai-sdk/anthropic');
    vi.mocked(revalidateCustomEndpointUrl).mockResolvedValue({ ok: true, normalizedUrl: '' });
  });

  it('revalidates an unauthenticated local-sentinel (apiKey="local") custom baseURL before any upstream call', async () => {
    const { revalidateCustomEndpointUrl } = await import('../src/registry/url-security.js');
    vi.mocked(revalidateCustomEndpointUrl).mockResolvedValueOnce({
      ok: false,
      error: 'URL resolves to a private or restricted network address.',
      hint: 'Use a public HTTPS endpoint.',
    });

    const anthropicFactory = vi.fn(() => ({ provider: 'should-not-reach' }));
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic: () => anthropicFactory }));

    const { createLanguageModel: create, EndpointUrlValidationError } = await import('../src/provider-factory.js');
    await expect(create({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'local',
      baseURL: 'https://rebind.example.com/v1',
    })).rejects.toBeInstanceOf(EndpointUrlValidationError);
    expect(revalidateCustomEndpointUrl).toHaveBeenCalledWith('https://rebind.example.com/v1', expect.objectContaining({ allowInsecureLocal: false }));
    expect(anthropicFactory).not.toHaveBeenCalled();
    vi.doUnmock('@ai-sdk/anthropic');
    vi.mocked(revalidateCustomEndpointUrl).mockResolvedValue({ ok: true, normalizedUrl: '' });
  });

});

describe('provider protocol dispatch', () => {
  it('routes Kimi Coding Plan k3 through openai-compatible Chat Completions with no Responses/WebSocket/OpenAI-OAuth options', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'k3',
      apiKey: 'test-kimi-membership-key',
      baseURL: 'https://api.kimi.com/coding/v1',
      providerId: 'kimi',
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'kimi',
      apiKey: 'test-kimi-membership-key',
      baseURL: 'https://api.kimi.com/coding/v1',
      includeUsage: true,
    });
    expect(factory).toHaveBeenCalledWith('k3');
    vi.doUnmock('@ai-sdk/openai-compatible');
  });

  it('routes z.ai GLM-5.2 through openai-compatible Chat Completions with no Responses/WebSocket/OpenAI-OAuth options', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

    const { createLanguageModel: create } = await import('../src/provider-factory.js');
    await create({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'glm-5.2',
      apiKey: 'sk-zai',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      providerId: 'zai',
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'zai',
      apiKey: 'sk-zai',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      includeUsage: true,
    });
    expect(factory).toHaveBeenCalledWith('glm-5.2');
    vi.doUnmock('@ai-sdk/openai-compatible');
  });

  it('emits thinking options only when metadata reports the capability', () => {
    expect(thinkingProviderOptions('@ai-sdk/openai-compatible')).toBeUndefined();
    expect(thinkingProviderOptions('@ai-sdk/openai')).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    });
    expect(thinkingProviderOptions('@ai-sdk/google', { reasoning: true })).toEqual({
      google: { thinkingConfig: { includeThoughts: true } },
    });
    expect(thinkingProviderOptions('@ai-sdk/google')).toBeUndefined();
  });
});
