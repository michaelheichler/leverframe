import { describe, it, expect, vi } from 'vitest';
import {
  deepMergeProviderOptions,
  effortProviderOptions,
  getReasoningCapabilities,
  isSdkMigratedNpm,
  maxToolsForNpm,
  shouldUseOpenAiResponsesEndpoint,
  thinkingProviderOptions,
} from '../src/provider-factory.js';
import { VERTEX_ANTHROPIC_NPM } from '../src/constants.js';
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

describe('isSdkMigratedNpm', () => {
  it('returns true for any OpenCode-assigned npm except anthropic', () => {
    expect(isSdkMigratedNpm('@ai-sdk/openai')).toBe(true);
    expect(isSdkMigratedNpm('@ai-sdk/cerebras')).toBe(true);
    expect(isSdkMigratedNpm('@ai-sdk/perplexity')).toBe(true);
    expect(isSdkMigratedNpm('@openrouter/ai-sdk-provider')).toBe(true);
    expect(isSdkMigratedNpm('gitlab-ai-provider')).toBe(true);
    expect(isSdkMigratedNpm(VERTEX_ANTHROPIC_NPM)).toBe(true);
  });

  it('returns false for anthropic passthrough and missing npm', () => {
    expect(isSdkMigratedNpm('@ai-sdk/anthropic')).toBe(false);
    expect(isSdkMigratedNpm(undefined)).toBe(false);
    expect(isSdkMigratedNpm('')).toBe(false);
  });
});

describe('shouldUseOpenAiResponsesEndpoint', () => {
  it('defaults every OpenAI model to the Responses endpoint', () => {
    expect(shouldUseOpenAiResponsesEndpoint('gpt-4o')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-3.5-turbo')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-5.6-sol')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-7-does-not-exist-yet')).toBe(true);
  });

  it('honors an explicit Chat Completions capability', () => {
    expect(shouldUseOpenAiResponsesEndpoint('legacy-model', 'chat')).toBe(false);
  });
});

describe('maxToolsForNpm', () => {
  it('caps Groq tool lists at 128', () => {
    expect(maxToolsForNpm('@ai-sdk/groq')).toBe(128);
  });

  it('does not cap non-Groq providers', () => {
    expect(maxToolsForNpm('@ai-sdk/openai')).toBeUndefined();
    expect(maxToolsForNpm(undefined)).toBeUndefined();
  });
});

describe('getReasoningCapabilities', () => {
  it('returns anthropic levels for claude-sonnet-4-6', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-sonnet-4-6');
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.supportsSummaries).toBe(true);
  });

  it('returns anthropic levels for Vertex Claude models', () => {
    const caps = getReasoningCapabilities(VERTEX_ANTHROPIC_NPM, 'claude-sonnet-4-6');
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'anthropic-thinking' });
  });

  it('returns empty levels for non-reasoning anthropic model', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-haiku-4-5-20251001');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
    expect(caps.supportsSummaries).toBe(false);
  });

  it('uses the reported levels for a Mistral model', () => {
    const caps = getReasoningCapabilities('@ai-sdk/mistral', 'mistral-large', {
      reasoning: true,
      supportedReasoningEfforts: ['high', 'off'],
      defaultReasoningEffort: 'high',
    });
    expect(caps.levels).toEqual(['high', 'off']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('does not turn a Google budget-token report into guessed effort levels', () => {
    const caps = getReasoningCapabilities('@ai-sdk/google', 'gemini-2.5-pro', { reasoning: true });
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
    expect(caps.mode).toBe('internal-only');
  });

  it('returns empty levels for unknown openai-compatible models', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'unknown');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
  });

  it('uses reported reasoning levels for a future OpenAI model', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai', 'gpt-6-astra', {
      reasoning: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high',
    });

    expect(caps.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.source).toBe('model-metadata');
  });

  it('forces the SDK reasoning path from reported capabilities', () => {
    const metadata = {
      reasoning: true,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    };

    expect(effortProviderOptions('@ai-sdk/openai', 'max', 'gpt-6-astra', metadata)).toEqual({
      openai: {
        reasoningEffort: 'max',
        forceReasoning: true,
        systemMessageMode: 'developer',
      },
    });
    expect(thinkingProviderOptions('@ai-sdk/openai', metadata)?.openai).toMatchObject({
      forceReasoning: true,
      systemMessageMode: 'developer',
    });
  });

  it('rejects an effort absent from the reported levels', () => {
    expect(effortProviderOptions('@ai-sdk/openai', 'max', 'gpt-6-astra', {
      reasoning: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    })).toBeUndefined();
  });

  it('returns empty levels for grok-build-0.1 (internal reasoning only)', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-build-0.1');
    expect(caps.levels).toEqual([]);
  });

  it('uses the reported effort levels for xAI models', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-4.3', {
      reasoning: true,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
      defaultReasoningEffort: 'low',
    });
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('low');
  });

  it('preserves the reported xAI default exactly', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-4.5', {
      reasoning: true,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
      defaultReasoningEffort: 'high',
    });
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('uses DeepSeek effort and toggle metadata without adding an off level', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'deepseek-v4-flash', {
      reasoning: true,
      supportedReasoningEfforts: ['high', 'max'],
      defaultReasoningEffort: 'high',
      supportsReasoningToggle: true,
    });
    expect(caps.levels).toEqual(['high', 'max']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'deepseek-thinking' });
  });

  it('uses reported GLM reasoning levels for OpenAI-compatible routes', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'glm-5.2', {
      reasoning: true,
      supportedParameters: ['reasoning_effort'],
      supportedReasoningEfforts: ['high', 'xhigh'],
      defaultReasoningEffort: 'high',
    });
    expect(caps.levels).toEqual(['high', 'xhigh']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'openai-reasoning-effort' });
  });

  it.each(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'])(
    'returns compatible reasoning levels for Kimi Coding Plan model %s',
    modelId => {
      const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', modelId, {
        reasoning: true,
        supportedParameters: ['reasoning_effort'],
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
      });
      expect(caps.levels).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(caps.defaultLevel).toBe('high');
      expect(caps.wireFormat).toEqual({ kind: 'openai-reasoning-effort' });
    },
  );

  it('maps DeepSeek effort to openaiCompatible reasoningEffort + thinking enabled', () => {
    const merged = deepMergeProviderOptions(
      effortProviderOptions('@ai-sdk/openai-compatible', 'max', 'deepseek-v4-flash', {
        reasoning: true,
        supportedReasoningEfforts: ['high', 'max'],
        supportsReasoningToggle: true,
      }),
    );
    expect(merged?.openaiCompatible).toMatchObject({ reasoningEffort: 'max' });
    expect(merged?.deepseek).toMatchObject({ thinking: { type: 'enabled' } });
  });

  it('omits an effort absent from DeepSeek metadata', () => {
    const opts = effortProviderOptions('@ai-sdk/openai-compatible', 'low', 'deepseek-v4-pro', {
      reasoning: true,
      supportedReasoningEfforts: ['high', 'max'],
      supportsReasoningToggle: true,
    });
    expect(opts).toBeUndefined();
  });

  it('preserves the reported GLM effort on OpenAI-compatible routes', () => {
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'xhigh', 'glm-5.2', {
      providerId: 'zai',
      reasoning: true,
      supportedParameters: ['reasoning_effort'],
      supportedReasoningEfforts: ['high', 'xhigh'],
    })).toEqual({
      zai: { reasoningEffort: 'xhigh' },
    });
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'low', 'glm-5.2', {
      reasoning: true,
      supportedParameters: ['reasoning_effort'],
      supportedReasoningEfforts: ['high', 'xhigh'],
    })).toBeUndefined();
  });
});

describe('effortProviderOptions + deepMergeProviderOptions', () => {
  it('merges OpenAI thinking + effort without dropping store/include', () => {
    const merged = deepMergeProviderOptions(
      thinkingProviderOptions('@ai-sdk/openai'),
      effortProviderOptions('@ai-sdk/openai', 'high', 'gpt-5.4', {
        reasoning: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      }),
    );
    expect(merged?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'high',
    });
  });

  it('merges Google thinking + reported effort', () => {
    const merged = deepMergeProviderOptions(
      thinkingProviderOptions('@ai-sdk/google', {
        reasoning: true,
        supportedReasoningEfforts: ['high'],
      }),
      effortProviderOptions('@ai-sdk/google', 'high', 'gemini-2.5-pro', {
        reasoning: true,
        supportedReasoningEfforts: ['high'],
      }),
    );
    expect(merged?.google?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingLevel: 'high',
    });
  });

  it('maps Vertex Claude effort to Anthropic thinking options', () => {
    expect(effortProviderOptions(VERTEX_ANTHROPIC_NPM, 'medium', 'claude-sonnet-4-6')).toEqual({
      anthropic: { thinking: { type: 'adaptive', effort: 'medium' } },
    });
  });
});

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

  it('uses the live minimum client version for Responses Lite models', async () => {
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
        version: OPENAI_OAUTH_ASTRA_MODEL.minimal_client_version,
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
