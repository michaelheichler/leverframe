import type { RegistryProvider } from './types.js';

export function isRetiredOpenAiProvider(provider: Pick<RegistryProvider, 'id' | 'templateId' | 'authType'>): boolean {
  return provider.id === 'openai-oauth'
    || (provider.authType === 'oauth' && (provider.id === 'openai' || provider.templateId === 'openai' || provider.templateId === 'openai-oauth'));
}
