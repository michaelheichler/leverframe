import { afterEach, expect, it, vi } from 'vitest';
import { peekStoredCredential, readStoredCredential } from '../src/credential-store.js';
import {
  resolveProviderAccountAuth,
  resolveProviderAuth,
  resolveProviderCredential,
  resolveStoredAccountCredential,
  resolveStoredProviderCredential,
} from '../src/env.js';
import type { StoredOAuthCredential } from '../src/oauth/types.js';

vi.mock('../src/credential-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/credential-store.js')>(),
  peekStoredCredential: vi.fn(),
  readStoredCredential: vi.fn(),
}));

const providerId = 'openai-chatgpt-plan';
const keyringName = 'oauth:provider:openai-chatgpt-plan';
const keyringRef = 'keyring:' + keyringName;

function credentialFixture(): StoredOAuthCredential {
  return {
    type: 'oauth', access: 'plan-access-token', refresh: 'plan-refresh-token',
    expires: Date.now() + 3_600_000, accountId: 'oaiapp_test',
    providerData: {
      clientId: 'oaiapp_test',
      hostId: 'urn:uuid:123e4567-e89b-42d3-a456-426614174000',
      subject: 'chatgpt-subject',
      scopes: ['chatgpt.tokens.use.direct'],
    },
  };
}

function account(authRef: string) {
  return { id: 'account', enabled: true, authRef };
}

function keyringValue(raw: string) {
  vi.mocked(peekStoredCredential).mockResolvedValue(raw);
  vi.mocked(readStoredCredential).mockResolvedValue(raw);
}

const admissionPaths = [
  { path: 'provider credential', use: async (ref: string) => ({ token: await resolveProviderCredential(providerId, ref) }) },
  { path: 'provider auth', use: async (ref: string) => {
    const { apiKey: token, ...identity } = await resolveProviderAuth(providerId, ref);
    return { token, ...identity };
  } },
  { path: 'account auth', use: async (ref: string) => {
    const { apiKey: token, ...identity } = await resolveProviderAccountAuth(providerId, account(ref));
    return { token, ...identity };
  } },
  { path: 'stored provider credential', use: async (ref: string) => {
    const { value: token, ...identity } = await resolveStoredProviderCredential(providerId, ref);
    return { token, ...identity };
  } },
  { path: 'stored account credential', use: async (ref: string) => {
    const { value: token, ...identity } = await resolveStoredAccountCredential(providerId, account(ref));
    return { token, ...identity };
  } },
];

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it.each(admissionPaths)('$path admits the issued ChatGPT plan token despite an environment override', async ({ path, use }) => {
  const credential = credentialFixture();
  keyringValue(JSON.stringify(credential));
  vi.stubEnv('LEVERFRAME_KEY_OPENAI_CHATGPT_PLAN', 'wrong-route-token');

  const auth = await use(keyringRef);

  const identity = path === 'provider credential' ? {} : { accountId: credential.accountId, providerData: credential.providerData };
  expect(auth).toMatchObject({ token: 'plan-access-token', ...identity });
});

const rejectedInputs = [
  { kind: 'an environment reference', ref: 'env:TEST_PLAN_ENV_KEY', raw: () => JSON.stringify(credentialFixture()) },
  { kind: 'a Codex OAuth reference', ref: 'keyring:oauth:provider:openai-oauth', raw: () => JSON.stringify(credentialFixture()) },
  { kind: 'a raw stored key', ref: keyringRef, raw: () => 'raw-key' },
  { kind: 'an API key inside an OAuth record', ref: keyringRef, raw: () => JSON.stringify({ ...credentialFixture(), access: 'sk-test-api-key' }) },
  { kind: 'a mismatched account', ref: keyringRef, raw: () => JSON.stringify({ ...credentialFixture(), accountId: 'oaiapp_mismatch' }) },
  { kind: 'an ungranted subscription scope', ref: keyringRef, raw: () => {
    const credential = credentialFixture();
    return JSON.stringify({ ...credential, providerData: { ...credential.providerData, scopes: ['openid'] } });
  } },
];

it.each(admissionPaths.flatMap(path => rejectedInputs.map(input => ({ ...path, ...input }))))(
  '$path refuses $kind for ChatGPT plan inference',
  async ({ use, ref, raw }) => {
    keyringValue(raw());
    vi.stubEnv('TEST_PLAN_ENV_KEY', 'wrong-route-token');

    const auth = await use(ref);

    expect(auth).toMatchObject({ token: null });
  },
);
