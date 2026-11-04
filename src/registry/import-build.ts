

export function oauthAuthRef(providerId: string): string {
  return `keyring:oauth:provider:${providerId}`;
}

export function toOAuthRegistryId(id: string): string {
  if (id === 'openai') return 'openai-oauth';
  return id;
}
import type { BillingMetadata, CachedModel, RegistryProvider } from './types.js';

export interface NativeClaudeProviderInput {
  models: CachedModel[];
  source: 'harness' | 'account';
  credentialKind: 'oauth' | 'api_key';
  billing?: BillingMetadata;
  now: string;
}

export function materializeNativeClaudeProvider(input: NativeClaudeProviderInput): RegistryProvider {
  return {
    id: 'anthropic', templateId: 'anthropic', name: 'Claude Code', enabled: true,
    authRef: 'claude-code', credentialSource: 'claude-code',
    authType: input.credentialKind === 'oauth' ? 'oauth' : 'api',
    ...(input.billing ? { billing: input.billing } : {}),
    api: {}, addedAt: input.now,
    modelsCache: { fetchedAt: input.now, source: input.source, models: input.models },
  };
}
