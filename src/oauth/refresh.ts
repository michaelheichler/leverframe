

import { OPENAI_CHATGPT_PLAN_PROVIDER_ID } from '../constants.js';
import { refreshChatGptPlanCredential } from './chatgpt-plan.js';
import { refreshAntigravityAccessToken } from './antigravity.js';
import type { StoredOAuthCredential } from './types.js';
import { accessTokenIsExpiring, NATIVE_OAUTH_PROVIDER_IDS, oauthCredentialNeedsRefresh, tokensToStoredCredential } from './types.js';

export function oauthCredentialShouldRefresh(
  cred: StoredOAuthCredential,
  providerId: string,
): boolean {
  if (cred.accessRejected === true) return true;
  if (oauthCredentialNeedsRefresh(cred)) return true;

  if ((NATIVE_OAUTH_PROVIDER_IDS as readonly string[]).includes(providerId) && accessTokenIsExpiring(cred.access)) return true;
  return false;
}

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
  if (providerId === OPENAI_CHATGPT_PLAN_PROVIDER_ID) return refreshChatGptPlanCredential(cred);
  if (providerId === 'antigravity') {
    const tokens = await refreshAntigravityAccessToken(cred.refresh);
    return tokensToStoredCredential(tokens, cred.refresh, cred.accountId, cred.providerData);
  }
  throw new Error(`OAuth refresh not implemented for provider "${providerId}"`);
}
