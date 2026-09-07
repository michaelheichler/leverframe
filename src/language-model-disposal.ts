

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

export async function disposeLanguageModel(model: LanguageModel): Promise<void> {
  if (isDisposableLanguageModel(model)) await model.dispose();
}
