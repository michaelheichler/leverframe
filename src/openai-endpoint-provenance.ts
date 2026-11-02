import type { LanguageModel } from 'ai';

const canonicalModels = new WeakSet<object>();

export function recordOpenAiEndpoint(model: LanguageModel, baseURL: string | undefined): void {
  const resolved = baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  if (typeof model === 'object' && model !== null && resolved.replace(/\/$/, '') === 'https://api.openai.com/v1') {
    canonicalModels.add(model);
  }
}

export function hasCanonicalOpenAiEndpoint(model: LanguageModel): boolean {
  return typeof model === 'object' && model !== null && canonicalModels.has(model);
}
