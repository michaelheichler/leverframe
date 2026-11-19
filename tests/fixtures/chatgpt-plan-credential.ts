import type { StoredOAuthCredential } from '../../src/oauth/types.js';

export function planAccountId(name: string): string {
  return 'oaiapp_' + name;
}

export function planCredential(access: string, name: string, partial: Partial<StoredOAuthCredential> = {}): StoredOAuthCredential {
  const clientId = planAccountId(name);
  return {
    type: 'oauth',
    access,
    refresh: 'fixture-plan-refresh',
    expires: Date.now() + 3_600_000,
    accountId: clientId,
    providerData: {
      clientId,
      subject: name,
      hostId: 'urn:uuid:123e4567-e89b-42d3-a456-426614174000',
      scopes: ['chatgpt.tokens.use.direct'],
    },
    ...partial,
  };
}
