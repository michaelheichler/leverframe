/** Metadata is required to prevent guessed routing. */
import { expect, it } from 'vitest';
import { mapCopilotModels, parseCopilotModelInfo, type CopilotModelSkipDiagnostic } from '../src/copilot/models.js';

const modelInfo = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: 'claude-sonnet-fixture',
  name: 'Claude Sonnet Fixture',
  supported_endpoints: ['/chat/completions'],
  capabilities: {
    type: 'chat',
    supports: { vision: true, reasoningEffort: true },
    limits: { max_context_window_tokens: 200_000 },
  },
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  ...overrides,
});

it('preserves provider-confirmed identifiers and camelCase capabilities', () => {
  const model = parseCopilotModelInfo(modelInfo({}));

  expect(model).toEqual(expect.objectContaining({
    id: 'claude-sonnet-fixture',
    name: 'Claude Sonnet Fixture',
    upstreamModelId: 'claude-sonnet-fixture',
    contextWindow: 200_000,
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
    reasoning: true,
    vision: true,
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
  }));
  expect(model.contextWindowUnconfirmed).toBeUndefined();
});

it('maps a transport-confirmed HTTP chat record without requiring editor visibility', () => {
  const model = parseCopilotModelInfo({
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    supported_endpoints: ['/chat/completions'],
    capabilities: {
      family: 'gpt-4o-mini',
      limits: {
        max_context_window_tokens: 128_000,
        max_output_tokens: 4_096,
        max_prompt_tokens: 64_000,
      },
      object: 'model_capabilities',
      supports: { parallel_tool_calls: true, streaming: true, tool_calls: true },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    model_picker_enabled: false,
  });

  expect(model).toEqual({
    id: 'gpt-4o-mini', name: 'GPT-4o mini', upstreamModelId: 'gpt-4o-mini',
    family: 'gpt-4o-mini', contextWindow: 128_000,
    inputTokenLimit: 64_000, outputTokenLimit: 4_096,
    supportsParallelToolCalls: true,
    npm: '@ai-sdk/openai-compatible', modelFormat: 'openai',
    apiUrl: 'https://api.githubcopilot.com',
  });
});

it.each([
  [['/chat/completions', '/responses', '/v1/messages'], '@ai-sdk/anthropic', 'anthropic'],
  [['/chat/completions', '/responses'], '@ai-sdk/openai', 'openai'],
  [['/chat/completions'], '@ai-sdk/openai-compatible', 'openai'],
])('selects the confirmed HTTP adapter for %j', (endpoints, npm, modelFormat) => {
  const model = parseCopilotModelInfo(modelInfo({ supported_endpoints: endpoints }));

  expect(model).toEqual(expect.objectContaining({ npm, modelFormat }));
});

it('accepts an explicit inference endpoint when the capability type is omitted', () => {
  const model = parseCopilotModelInfo(modelInfo({
    capabilities: {}, supported_endpoints: ['/responses'],
  }));

  expect(model.npm).toBe('@ai-sdk/openai');
});

it('ignores upstream URL overrides even for a confirmed HTTP endpoint', () => {
  const model = parseCopilotModelInfo(modelInfo({
    supported_endpoints: ['/v1/messages'],
    apiUrl: 'https://untrusted.example',
    api_url: 'https://untrusted.example',
    url: 'https://untrusted.example',
  }));

  expect(model.apiUrl).toBe('https://api.githubcopilot.com');
});

it.each([
  { supported_endpoints: [] },
  { supported_endpoints: ['/embeddings'] },
  { supported_endpoints: ['/v1/chat/completions'] },
  { supported_endpoints: ['https://untrusted.example/responses'] },
])(
  'rejects explicit unsupported endpoint sets %j', ({ supported_endpoints }) => {
    expect(() => parseCopilotModelInfo(modelInfo({ supported_endpoints })))
      .toThrow(/supported_endpoints/);
  },
);

it('does not guess an endpoint when both endpoints and chat type are absent', () => {
  expect(() => parseCopilotModelInfo(modelInfo({ capabilities: {}, supported_endpoints: undefined }))).toThrow(/transport is unknown/);
});

it('does not infer chat completions from the chat capability alone', () => {
  expect(() => parseCopilotModelInfo(modelInfo({ supported_endpoints: undefined }))).toThrow(/transport is unknown/);
});

it('does not parse a completion model as a chat model', () => {
  expect(() => parseCopilotModelInfo(modelInfo({
    capabilities: { type: 'completion' }, supported_endpoints: ['/chat/completions'],
  }))).toThrow(TypeError);
});

it.each(['reasoning_effort', 'reasoning'])('maps snake_case capabilities with %s', field => {
  const model = parseCopilotModelInfo(modelInfo({
    capabilities: {
      type: 'chat',
      supports: { [field]: true, parallel_tool_calls: false, vision: true },
      limits: { vision: { max_prompt_images: 5 } },
    },
    supported_reasoning_efforts: ['low', 'high', 'unknown-live-value'],
    default_reasoning_effort: 'high',
  }));

  expect(model).toEqual(expect.objectContaining({
    reasoning: true, vision: true, supportsParallelToolCalls: false,
    supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
  }));
});

it('preserves an explicit false reasoning capability', () => {
  const model = parseCopilotModelInfo(modelInfo({
    capabilities: { type: 'chat', supports: { reasoning_effort: false } },
  }));

  expect(model.reasoning).toBe(false);
});

it('marks an absent context limit as unconfirmed without guessing', () => {
  const model = parseCopilotModelInfo(modelInfo({
    capabilities: {
      type: 'chat', supports: { vision: false, reasoningEffort: false }, limits: {},
    },
    supportedReasoningEfforts: undefined, defaultReasoningEffort: undefined,
  }));

  expect(model.contextWindow).toBeUndefined();
  expect(model.contextWindowUnconfirmed).toBe(true);
  expect(model.vision).toBe(false);
  expect(model.reasoning).toBe(false);
  expect(model.supportedReasoningEfforts).toBeUndefined();
  expect(model.defaultReasoningEffort).toBeUndefined();
});

it('accepts chat records with optional capability groups omitted', () => {
  const model = parseCopilotModelInfo(modelInfo({
    capabilities: { type: 'chat' },
    supportedReasoningEfforts: undefined, defaultReasoningEffort: undefined,
  }));

  expect(model).toEqual(expect.objectContaining({ contextWindowUnconfirmed: true }));
  for (const field of ['vision', 'reasoning', 'supportsParallelToolCalls', 'family', 'inputTokenLimit', 'outputTokenLimit']) {
    expect(model).not.toHaveProperty(field);
  }
});

it('does not infer capability flags from names, vision limits, or tool support', () => {
  const model = parseCopilotModelInfo(modelInfo({
    capabilities: {
      type: 'chat', supports: { tool_calls: true, streaming: true },
      limits: { max_context_window_tokens: 128_000, vision: { max_prompt_images: 5 } },
    },
  }));

  expect(model.contextWindow).toBe(128_000);
  expect(model.vision).toBeUndefined();
  expect(model.reasoning).toBeUndefined();
  expect(model.supportsParallelToolCalls).toBeUndefined();
  expect(model).not.toHaveProperty('toolCall');
  expect(model).not.toHaveProperty('tool_call');
});

it('treats zero token limits as unconfirmed', () => {
  const model = parseCopilotModelInfo(modelInfo({
    capabilities: {
      type: 'chat',
      limits: { max_context_window_tokens: 0, max_prompt_tokens: 0, max_output_tokens: 0 },
    },
  }));

  expect(model.contextWindow).toBeUndefined();
  expect(model.contextWindowUnconfirmed).toBe(true);
  expect(model.inputTokenLimit).toBeUndefined();
  expect(model.outputTokenLimit).toBeUndefined();
});

it('keeps models when the payload includes unknown reasoning effort labels', () => {
  const model = parseCopilotModelInfo(modelInfo({
    supportedReasoningEfforts: ['low', 'unknown-live-value', 'high'],
    defaultReasoningEffort: 'unknown-live-value',
  }));

  expect(model.supportedReasoningEfforts).toEqual(['low', 'high']);
  expect(model.defaultReasoningEffort).toBeUndefined();
});

it('preserves confirmed effort labels supported by the HTTP adapters', () => {
  const model = parseCopilotModelInfo(modelInfo({
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'minimal',
  }));
  expect(model.supportedReasoningEfforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  expect(model.defaultReasoningEffort).toBe('minimal');
});

it.each(['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens'])(
  'rejects invalid %s values', field => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '128000', null]) {
      expect(() => parseCopilotModelInfo(modelInfo({
        capabilities: { type: 'chat', limits: { [field]: value } },
      }))).toThrow(TypeError);
    }
  },
);

it.each([
  null, {}, modelInfo({ id: '' }), modelInfo({ name: 42 }),
  modelInfo({ capabilities: null }),
  modelInfo({ capabilities: { type: 42 } }),
  modelInfo({ capabilities: { type: 'chat', family: 42 } }),
  modelInfo({ capabilities: { type: 'chat', supports: { vision: 'yes' } } }),
  modelInfo({ capabilities: { type: 'chat', supports: { reasoning_effort: 'yes' } } }),
  modelInfo({ capabilities: { type: 'chat', supports: { parallel_tool_calls: 'yes' } } }),
  modelInfo({ capabilities: { type: 'chat', supports: [] } }),
  modelInfo({ capabilities: { type: 'chat', limits: 'unknown' } }),
  modelInfo({ supportedReasoningEfforts: ['medium', 42] }),
  modelInfo({ defaultReasoningEffort: 42 }),
  modelInfo({ supported_reasoning_efforts: ['medium', 42] }),
  modelInfo({ supported_reasoning_efforts: null }),
  modelInfo({ default_reasoning_effort: 42 }),
  modelInfo({ supported_endpoints: '/responses' }),
  modelInfo({ supported_endpoints: ['/responses', 42] }),
  modelInfo({ supported_endpoints: null }),
])('rejects malformed model metadata %#', record => {
  expect(() => parseCopilotModelInfo(record)).toThrow(TypeError);
});

it('validates every chat record and preserves order', () => {
  const models = mapCopilotModels([
    modelInfo({ id: 'first', name: 'First' }),
    modelInfo({ id: 'second', name: 'Second' }),
  ]);

  expect(models.map(model => model.id)).toEqual(['first', 'second']);
});

it('keeps the complete list when one valid record has sparse chat capabilities', () => {
  const models = mapCopilotModels([
    modelInfo({ id: 'sparse', name: 'Sparse', capabilities: { type: 'chat' } }),
    modelInfo({ id: 'complete', name: 'Complete' }),
  ]);

  expect(models.map(model => model.id)).toEqual(['sparse', 'complete']);
  expect(models[0]).toEqual(expect.objectContaining({ contextWindowUnconfirmed: true }));
});

it('excludes non-chat records without requiring chat-only metadata', () => {
  const models = mapCopilotModels([
    { id: 'gpt-41-copilot', capabilities: { type: 'completion', supports: { streaming: true } } },
    modelInfo({ id: 'chat', model_picker_enabled: false }),
    { id: 'embedding-fixture', capabilities: { type: 'embeddings' } },
  ]);

  expect(models.map(model => model.id)).toEqual(['chat']);
});

it('excludes models whose policy is not enabled', () => {
  const models = mapCopilotModels([
    modelInfo({ id: 'enabled', policy: { state: 'enabled' } }),
    modelInfo({ id: 'disabled', policy: { state: 'disabled' } }),
    modelInfo({ id: 'unconfigured', policy: { state: 'unconfigured' } }),
    modelInfo({ id: 'no-policy' }),
  ]);

  expect(models.map(model => model.id)).toEqual(['enabled', 'no-policy']);
});

it('filters disabled records before validating unused chat metadata or transport', () => {
  const skippedModels: CopilotModelSkipDiagnostic[] = [];
  expect(mapCopilotModels([
    modelInfo({ name: 42, policy: { state: 'disabled' } }),
    modelInfo({ supported_endpoints: undefined, policy: { state: 'disabled' } }),
  ], skippedModels)).toEqual([]);
  expect(skippedModels.map(record => record.kind)).toEqual(['policy', 'policy']);
});

it.each([null, {}, { state: 'unexpected' }])('diagnoses malformed policies %j', policy => {
  const skippedModels: CopilotModelSkipDiagnostic[] = [];
  expect(mapCopilotModels([modelInfo({ policy })], skippedModels)).toEqual([]);
  expect(skippedModels).toEqual([expect.objectContaining({ index: 0, kind: 'schema', reason: expect.stringMatching(/policy|state/) })]);
});

it('rejects a non-array listModels result', () => {
  expect(() => mapCopilotModels({ models: [] })).toThrow(TypeError);
});

it('retains valid siblings in order and diagnoses each malformed record without requiring an ID', () => {
  const skippedModels: CopilotModelSkipDiagnostic[] = [];
  const models = mapCopilotModels([
    modelInfo({ id: 'first' }),
    null,
    modelInfo({ id: 'invalid', name: 42 }),
    { id: 'missing-capabilities' },
    modelInfo({ id: 'last', capabilities: { type: 'chat' }, supported_endpoints: ['/responses'] }),
  ], skippedModels);

  expect(models.map(model => model.id)).toEqual(['first', 'last']);
  expect(models[1]).toMatchObject({ npm: '@ai-sdk/openai', contextWindowUnconfirmed: true });
  expect(skippedModels).toEqual([
    { index: 1, kind: 'schema', reason: expect.stringContaining('record must be an object') },
    { index: 2, modelId: 'invalid', kind: 'schema', reason: expect.stringContaining('name must be') },
    { index: 3, modelId: 'missing-capabilities', kind: 'schema', reason: expect.stringContaining('capabilities must be') },
  ]);
});

it.each([undefined, [], ['/embeddings'], ['/v1/chat/completions'], ['https://untrusted.example/responses']])(
  'diagnoses transport-unknown exclusions for %j without hiding supported siblings', endpoints => {
    const skippedModels: CopilotModelSkipDiagnostic[] = [];
    const models = mapCopilotModels([
      modelInfo({ id: 'unknown', supported_endpoints: endpoints }),
      modelInfo({ id: 'supported', supported_endpoints: ['/v1/messages'] }),
    ], skippedModels);

    expect(models.map(model => model.id)).toEqual(['supported']);
    expect(skippedModels).toEqual([{
      index: 0, modelId: 'unknown', kind: 'transport-unknown',
      reason: expect.stringContaining('transport is unknown'),
    }]);
  },
);

it('distinguishes malformed endpoints from missing or unsupported transports', () => {
  const skippedModels: CopilotModelSkipDiagnostic[] = [];
  mapCopilotModels([modelInfo({ supported_endpoints: ['/responses', 42] })], skippedModels);
  expect(skippedModels).toEqual([expect.objectContaining({ kind: 'schema' })]);
});

it('retains all three protocol adapters, confirmed limits and capabilities in a mixed catalog', () => {
  const models = mapCopilotModels([
    modelInfo({ id: 'messages', supported_endpoints: ['/v1/messages', '/responses', '/chat/completions'] }),
    modelInfo({ id: 'responses', supported_endpoints: ['/responses', '/chat/completions'] }),
    modelInfo({ id: 'chat', supported_endpoints: ['/chat/completions'] }),
  ]);
  expect(models.map(model => model.npm)).toEqual(['@ai-sdk/anthropic', '@ai-sdk/openai', '@ai-sdk/openai-compatible']);
  for (const model of models) {
    expect(model).toMatchObject({
      contextWindow: 200_000, reasoning: true, vision: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium',
      apiUrl: 'https://api.githubcopilot.com',
    });
  }
  expect(models.map(model => model.supportedParameters)).toEqual([undefined, undefined, ['reasoning_effort']]);
});
