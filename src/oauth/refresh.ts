/** Refreshes renewable OAuth credentials before inference. */

import { refreshOpenAiAccessToken } from './openai.js';
import type { StoredOAuthCredential } from './types.js';
import { accessTokenIsExpiring, NATIVE_OAUTH_PROVIDER_IDS, oauthCredentialNeedsRefresh, tokensToStoredCredential } from './types.js';

export function oauthCredentialShouldRefresh(
  cred: StoredOAuthCredential,
  providerId: string,
): boolean {
  if (cred.accessRejected === true) return true;
  if (oauthCredentialNeedsRefresh(cred)) return true;
  // Renewable OAuth access tokens are checked before inference. Durable opaque tokens have no JWT expiry.
  if ((NATIVE_OAUTH_PROVIDER_IDS as readonly string[]).includes(providerId) && accessTokenIsExpiring(cred.access)) return true;
  return false;
}

/**
 * Refreshes renewable native credentials and rejects durable or custom provider IDs.
 * The registry accepts custom string IDs, so unsupported values fail here with their exact ID.
 */
export async function refreshStoredOAuthCredential(
  providerId: string,
  cred: StoredOAuthCredential,
): Promise<StoredOAuthCredential> {
  if (providerId === 'github-copilot') {
    throw new Error(
      'github-copilot: GitHub OAuth token cannot be refreshed; run leverframe providers auth github-copilot',
    );
  }
  if (!cred.refresh) {
    throw new Error(`${providerId}: OAuth refresh token missing. Run leverframe providers auth ${providerId}`);
  }
  if (providerId !== 'openai' && providerId !== 'openai-oauth') {
    throw new Error(`OAuth refresh not implemented for provider "${providerId}"`);
  }

  const tokens = await refreshOpenAiAccessToken(cred.refresh);
  return tokensToStoredCredential(tokens, cred.refresh, cred.accountId, cred.providerData);
}
