import { updateRegistry } from '../registry/io.js';
import type { RegistryProvider } from '../registry/types.js';
import type { RefreshProviderResult } from '../registry/refresh-models.js';
import { resolveAntigravityAuth } from './auth.js';
import { fetchAntigravityModels } from './models.js';
import { AntigravityError } from './types.js';

export async function refreshAntigravityProviderModels(provider: RegistryProvider | undefined): Promise<RefreshProviderResult> {
  const identity = { id: 'antigravity', name: provider?.name ?? 'Google Antigravity' };
  if (!provider?.enabled || provider.authType !== 'oauth') {
    return { ...identity, ok: false, reason: 'Antigravity requires an enabled subscription OAuth provider.' };
  }
  try {
    const auth = await resolveAntigravityAuth();
    const models = await fetchAntigravityModels(auth);
    const latestAuth = await resolveAntigravityAuth(auth.accountId);
    if (latestAuth.projectId !== auth.projectId) {
      throw new AntigravityError('Antigravity project changed during model discovery. Retry refresh.', 409);
    }
    updateRegistry(current => {
      const entry = current.providers.find(item => item.id === 'antigravity');
      if (!entry) return;
      entry.modelsCache = { fetchedAt: new Date().toISOString(), oauthAccountId: auth.accountId, models };
      entry.refreshedAt = entry.modelsCache.fetchedAt;
      delete entry.modelDiscoveryError;
    });
    return { ...identity, ok: true, modelSource: 'live', modelCount: models.length };
  } catch (error) {
    return { ...identity, ok: false, reason: error instanceof AntigravityError ? error.message : 'Antigravity model discovery failed.' };
  }
}
