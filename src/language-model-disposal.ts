/**
 * Narrows optional provider cleanup without changing the shared AI SDK model type.
 * Providers without owned resources remain no-op disposal targets.
 */

import type { LanguageModel } from 'ai';

interface DisposableLanguageModel {
  dispose(): void | Promise<void>;
}

function isDisposableLanguageModel(model: LanguageModel): model is LanguageModel & DisposableLanguageModel {
  return typeof model === 'object'
    && model !== null
    && 'dispose' in model
    && typeof model.dispose === 'function';
}

/** Disposes provider-owned resources when a model exposes an explicit disposer. */
export async function disposeLanguageModel(model: LanguageModel): Promise<void> {
  if (isDisposableLanguageModel(model)) await model.dispose();
}
