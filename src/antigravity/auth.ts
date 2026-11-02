import { resolveProviderAuth, resolveProviderAccountAuth } from '../env.js';
import { loadRegistry } from '../registry/io.js';
import { oauthAuthRef } from '../registry/import-build.js';
import { AntigravityError, objectRecord, type AntigravityAuthSnapshot } from './types.js';

export async function resolveAntigravityAuth(expectedAccountId?: string, options: { signal?: AbortSignal; registryAccountId?: string } = {}): Promise<AntigravityAuthSnapshot> {
  options.signal?.throwIfAborted();
  if (process.env['LEVERFRAME_KEY_ANTIGRAVITY']?.trim()) {
    throw new AntigravityError('Antigravity uses subscription OAuth, not environment credentials.', 401);
  }
  const account = options.registryAccountId === undefined ? undefined : loadRegistry().providers
    .find(provider => provider.id === 'antigravity' && provider.enabled)?.accounts
    ?.find(item => item.id === options.registryAccountId && item.enabled);
  if (options.registryAccountId !== undefined && !account) throw new AntigravityError('The selected subscription account is unavailable.', 401);
  const auth = account ? await resolveProviderAccountAuth('antigravity', account)
    : await resolveProviderAuth('antigravity', oauthAuthRef('antigravity'));
  options.signal?.throwIfAborted();
  if (!auth.apiKey || !/^[\x21-\x7e]+$/.test(auth.apiKey) || !auth.accountId) {
    throw new AntigravityError('Sign in with leverframe providers auth antigravity.', 401);
  }
  if (expectedAccountId && expectedAccountId !== auth.accountId) {
    throw new AntigravityError('Antigravity account changed. Refresh the model list and select a model again.', 409);
  }
  const projectId = objectRecord(auth.providerData)?.projectId;
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(projectId)) {
    throw new AntigravityError('Antigravity managed project is missing. Sign in again.', 401);
  }
  return { accessToken: auth.apiKey, accountId: auth.accountId, projectId };
}
