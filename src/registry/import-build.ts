

export function oauthAuthRef(providerId: string): string {
  return `keyring:oauth:provider:${providerId}`;
}

export function toOAuthRegistryId(id: string): string {
  if (id === 'openai') return 'openai-oauth';
  return id;
}
