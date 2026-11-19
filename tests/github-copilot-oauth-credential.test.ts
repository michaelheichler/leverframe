

import { describe, expect, it } from 'vitest';
import { githubCopilotTokensToStoredCredential } from '../src/oauth/github-copilot.js';
import { oauthCredentialShouldRefresh, refreshStoredOAuthCredential } from '../src/oauth/refresh.js';
import { oauthCredentialToKeychainJson, type OAuthTokenResponse } from '../src/oauth/types.js';

const ACCESS_TOKEN = ['fixture', 'access', 'token', 'for', 'tests', 'only'].join('-');

describe('githubCopilotTokensToStoredCredential', () => {
  it('stores a durable credential without fabricating a refresh token', () => {
    const tokens: OAuthTokenResponse = { access_token: ACCESS_TOKEN };

    const cred = githubCopilotTokensToStoredCredential(tokens);

    expect(cred.type).toBe('oauth');
    expect(cred.access).toBe(ACCESS_TOKEN);
    expect(cred.refresh).toBe('');
    const hundredYearsMs = 100 * 365 * 24 * 60 * 60 * 1000;
    expect(cred.expires).toBeGreaterThan(Date.now() + hundredYearsMs);
  });

  it('never reports needing a proactive refresh once stored', () => {
    const cred = githubCopilotTokensToStoredCredential({ access_token: ACCESS_TOKEN });

    expect(oauthCredentialShouldRefresh(cred, 'github-copilot')).toBe(false);
  });

  it('keeps the non-expiring sentinel finite so it survives a keychain JSON round trip', () => {
    const cred = githubCopilotTokensToStoredCredential({ access_token: ACCESS_TOKEN });

    expect(Number.isFinite(cred.expires)).toBe(true);
    const roundTripped = JSON.parse(oauthCredentialToKeychainJson(cred)) as { expires: number };
    expect(roundTripped.expires).toBe(cred.expires);
  });

  it('requires reauthentication when GitHub rejects the durable token', async () => {
    const cred = {
      ...githubCopilotTokensToStoredCredential({ access_token: ACCESS_TOKEN }),
      accessRejected: true as const,
    };

    expect(oauthCredentialShouldRefresh(cred, 'github-copilot')).toBe(true);
    await expect(refreshStoredOAuthCredential('github-copilot', cred))
      .rejects.toThrow(/leverframe providers auth github-copilot/);
  });
});
