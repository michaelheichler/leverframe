import { describe, expect, it } from 'vitest';
import {
  buildDeps,
  callOptions,
  loadCopilotLanguageModelModule,
} from './fixtures/copilot-connector-contract.js';

const SESSION_ID = '55555555-5555-4555-8555-555555555555';

describe('createCopilotLanguageModel request validation', () => {
  it('rejects a non-UUID session identity before loading the runtime', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, getRuntimeSpy } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await expect(model.doStream(callOptions({
      claudeSessionId: 'not-a-session-id',
    }))).rejects.toThrow(/session ID/i);
    expect(getRuntimeSpy).not.toHaveBeenCalled();
  });

  it('rejects an unsupported reasoning effort before loading the runtime', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, getRuntimeSpy } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await expect(model.doStream(callOptions({
      claudeSessionId: SESSION_ID,
      reasoningEffort: 'extreme',
    }))).rejects.toThrow(/reasoning effort/i);
    expect(getRuntimeSpy).not.toHaveBeenCalled();
  });

  it('rejects provider-owned tools instead of dropping them silently', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, getRuntimeSpy } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await expect(model.doStream(callOptions({
      claudeSessionId: SESSION_ID,
      tools: [{ type: 'provider', id: 'example.search', name: 'search', args: {} }],
    }))).rejects.toThrow(/provider tool/i);
    expect(getRuntimeSpy).not.toHaveBeenCalled();
  });
});
