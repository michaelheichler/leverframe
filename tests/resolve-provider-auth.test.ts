import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { resolveProviderAuth } from '../src/env.js';
import * as oauth from '../src/oauth/refresh.js';
import type { StoredOAuthCredential } from '../src/oauth/types.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-provider-auth-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('LEVERFRAME_KEY_OPENAI_OAUTH', '');
  vi.stubEnv('LEVERFRAME_KEY_API_FIXTURE', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function credential(overrides: Partial<StoredOAuthCredential> = {}): StoredOAuthCredential {
  return {
    type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000,
    accountId: 'old-account', providerData: { organization: 'old-organization' }, ...overrides,
  };
}

function isolatedKeyring(initial: StoredOAuthCredential) {
  let stored = JSON.stringify(initial);
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.service !== 'leverframe' || input.account !== 'oauth:provider:openai-oauth') {
      throw new Error('Unexpected fixture credential');
    }
    if (input.operation === 'read') return { ok: true, value: stored };
    if (input.operation === 'write') {
      stored = input.value;
      return { ok: true, value: null };
    }
    throw new Error('Unexpected fixture operation');
  });
  return () => JSON.parse(stored) as StoredOAuthCredential;
}

it.each([
  { reason: 'expired', overrides: { expires: 0 } },
  { reason: 'rejected', overrides: { accessRejected: true as const } },
])('returns refreshed account metadata for $reason credentials', async ({ overrides }) => {
  const initial = credential(overrides);
  const stored = isolatedKeyring(initial);
  const replacement = credential({
    access: 'new-access', refresh: 'new-refresh', accountId: 'new-account',
    providerData: { organization: 'new-organization' },
  });
  const refresh = vi.spyOn(oauth, 'refreshStoredOAuthCredential').mockResolvedValue(replacement);

  const result = await resolveProviderAuth('openai-oauth', 'keyring:oauth:provider:openai-oauth');

  expect(result).toEqual({
    apiKey: 'new-access', accountId: 'new-account', providerData: { organization: 'new-organization' },
  });
  expect(stored()).toEqual(replacement);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledWith('openai-oauth', initial);
});

it('does not reuse a rejected access token when refresh returns that token again', async () => {
  const initial = credential({ accessRejected: true });
  const stored = isolatedKeyring(initial);
  const refresh = vi.spyOn(oauth, 'refreshStoredOAuthCredential')
    .mockResolvedValue(credential({ access: initial.access }));

  const result = await resolveProviderAuth('openai-oauth', 'keyring:oauth:provider:openai-oauth');

  expect(result).toEqual({ apiKey: null });
  expect(stored().accessRejected).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledWith('openai-oauth', initial);
});

it('honors an environment override without reading Keychain metadata', async () => {
  vi.stubEnv('LEVERFRAME_KEY_OPENAI_OAUTH', 'environment-access');
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation')
    .mockRejectedValue(new Error('Keychain must not be accessed'));

  const result = await resolveProviderAuth('openai-oauth', 'keyring:oauth:provider:openai-oauth');

  expect(result).toEqual({ apiKey: 'environment-access' });
  expect(keyring).not.toHaveBeenCalled();
});

it('resolves a normal API key with one Keychain read', async () => {
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation')
    .mockResolvedValue({ ok: true, value: 'fixture-api-key' });

  const result = await resolveProviderAuth('api-fixture', 'keyring:provider:api-fixture');

  expect(result).toEqual({ apiKey: 'fixture-api-key' });
  expect(keyring).toHaveBeenCalledTimes(1);
  expect(keyring).toHaveBeenCalledWith({ operation: 'read', service: 'leverframe', account: 'provider:api-fixture' });
});
