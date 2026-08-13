/**
 * Verifies durable GitHub OAuth credential storage and existing OpenAI refresh behavior.
 */

import { describe, expect, it } from 'vitest';
import { githubCopilotTokensToStoredCredential } from '../src/oauth/github-copilot.js';
import { extractOpenAiAccountId } from '../src/oauth/openai.js';
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

describe('existing OpenAI oauth semantics stay unchanged', () => {
  it('still extracts the ChatGPT account id from the OpenAI id token', () => {
    const header = Buffer.from('{}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'user-123' })).toString('base64url');

    expect(extractOpenAiAccountId({ access_token: `${header}.${payload}.x`, refresh_token: 'r' })).toBe('user-123');
  });

  it('still flags openai-oauth credentials for proactive refresh from a soon-to-expire JWT', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })).toString('base64url');
    const cred = {
      type: 'oauth' as const,
      access: `${header}.${payload}.sig`,
      refresh: 'rt',
      expires: Date.now() + 10 * 60 * 1000,
    };

    expect(oauthCredentialShouldRefresh(cred, 'openai-oauth')).toBe(true);
  });
});
