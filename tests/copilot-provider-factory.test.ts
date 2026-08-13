import { describe, expect, it } from 'vitest';
import { createLanguageModel } from '../src/provider-factory.js';

describe('createLanguageModel GitHub Copilot dispatch', () => {
  it('uses the Copilot connector instead of the generic SDK loader', async () => {
    const model = await createLanguageModel({
      npm: '@github/copilot-sdk',
      modelId: 'claude-sonnet-4-6',
      apiKey: ['fixture', 'github', 'credential'].join('-'),
    });

    const copilotModel = model as { provider?: string; modelId?: string };
    expect(copilotModel.provider).toBe('github-copilot');
    expect(copilotModel.modelId).toBe('claude-sonnet-4-6');
  });
});
