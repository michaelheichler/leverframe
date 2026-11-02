import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveProviderAuth } = vi.hoisted(() => ({ resolveProviderAuth: vi.fn() }));
vi.mock('../src/env.js', () => ({ resolveProviderAuth }));

import { resolveAntigravityAuth } from '../src/antigravity/auth.js';

beforeEach(() => {
  vi.stubEnv('LEVERFRAME_KEY_ANTIGRAVITY', '');
  resolveProviderAuth.mockReset();
  resolveProviderAuth.mockResolvedValue({
    apiKey: 'access-a', accountId: 'account-a', providerData: { projectId: 'project-a' },
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('resolveAntigravityAuth', () => {
  it('returns a coherent access token, account, and managed project', async () => {
    const auth = await resolveAntigravityAuth('account-a');

    expect(auth).toEqual({ accessToken: 'access-a', accountId: 'account-a', projectId: 'project-a' });
  });

  it('rejects a token resolved for a different signed-in account', async () => {
    await expect(resolveAntigravityAuth('account-b')).rejects.toThrow(/account/i);
  });

  it('rejects credentials without a managed project', async () => {
    resolveProviderAuth.mockResolvedValue({ apiKey: 'access-a', accountId: 'account-a', providerData: {} });

    await expect(resolveAntigravityAuth('account-a')).rejects.toThrow(/project/i);
  });

  it('refuses the provider environment override before reading credentials', async () => {
    vi.stubEnv('LEVERFRAME_KEY_ANTIGRAVITY', 'api-key-from-environment');

    await expect(resolveAntigravityAuth('account-a')).rejects.toThrow(/environment|oauth|subscription/i);

    expect(resolveProviderAuth).not.toHaveBeenCalled();
  });
});
