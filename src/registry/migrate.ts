import type { ProviderRegistry } from './types.js';

export function migrateOAuthOpenAiProvider(registry: ProviderRegistry): boolean {
  if (registry.providers.some(p => p.id === 'openai-oauth')) return false;

  const idx = registry.providers.findIndex(
    p => p.id === 'openai' && p.authType === 'oauth',
  );
  if (idx < 0) return false;

  const existing = registry.providers[idx]!;
  registry.providers[idx] = {
    ...existing,
    id: 'openai-oauth',
    templateId: existing.templateId || 'openai',
    name: existing.name === 'OpenAI' ? 'OpenAI (ChatGPT)' : existing.name,
  };
  return true;
}
