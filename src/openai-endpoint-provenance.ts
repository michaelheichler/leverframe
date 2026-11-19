import type { LanguageModel } from 'ai';

const canonicalModels = new WeakSet<object>();

export function isCanonicalOpenAiBaseUrl(baseURL: string | undefined): boolean {
  const resolved = baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  return resolved.replace(/\/$/, '') === 'https://api.openai.com/v1';
}

export function recordOpenAiEndpoint(model: LanguageModel, baseURL: string | undefined): void {
  if (typeof model === 'object' && model !== null && isCanonicalOpenAiBaseUrl(baseURL)) {
    canonicalModels.add(model);
  }
}

export function hasCanonicalOpenAiEndpoint(model: LanguageModel): boolean {
  return typeof model === 'object' && model !== null && canonicalModels.has(model);
}
