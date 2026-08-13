import type { LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { disposeLanguageModel } from '../src/language-model-disposal.js';

function languageModel(dispose?: () => Promise<void>): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'fixture',
    modelId: 'fixture-model',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
    ...(dispose === undefined ? {} : { dispose }),
  } as LanguageModel;
}

describe('disposeLanguageModel', () => {
  it('awaits a model-owned disposer', async () => {
    const dispose = vi.fn(async () => undefined);

    await disposeLanguageModel(languageModel(dispose));

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps unrelated AI SDK providers as no-op disposal targets', async () => {
    await expect(disposeLanguageModel(languageModel())).resolves.toBeUndefined();
  });
});
