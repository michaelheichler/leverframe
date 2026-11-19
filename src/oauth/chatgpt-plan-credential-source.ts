import { OPENAI_CHATGPT_PLAN_PROVIDER_ID } from '../constants.js';
import { peekStoredCredential, readStoredCredential } from '../credential-store.js';
import type { ResolvedProviderAuth, StoredProviderCredential } from '../env.js';
import { parseChatGptPlanCredential } from './chatgpt-plan.js';
import { oauthCredentialShouldRefresh } from './refresh.js';

type RefreshCredential = (
  account: string,
  providerId: string,
  raw: string,
  diag?: (message: string) => void,
  rejectedAccessToken?: string,
) => Promise<string | null>;

export async function resolveStoredChatGptPlanCredential(account?: string): Promise<StoredProviderCredential> {
  const credential = account ? parseChatGptPlanCredential(await peekStoredCredential(account)) : null;
  if (!credential) return { value: null, refreshDue: false };
  return {
    value: credential.access, refreshDue: oauthCredentialShouldRefresh(credential, OPENAI_CHATGPT_PLAN_PROVIDER_ID),
    accountId: credential.accountId, providerData: credential.providerData,
  };
}

export async function resolveChatGptPlanAuth(
  account: string | undefined,
  refresh: RefreshCredential,
  diag?: (message: string) => void,
  rejectedAccessToken?: string,
): Promise<ResolvedProviderAuth> {
  if (!account) return { apiKey: null };
  const raw = await readStoredCredential(account, diag);
  const credential = parseChatGptPlanCredential(raw);
  if (!credential || raw === null) return { apiKey: null };
  if (!credential.accessRejected && credential.access !== rejectedAccessToken
    && !oauthCredentialShouldRefresh(credential, OPENAI_CHATGPT_PLAN_PROVIDER_ID)) {
    return { apiKey: credential.access, accountId: credential.accountId, providerData: credential.providerData };
  }
  const apiKey = await refresh(account, OPENAI_CHATGPT_PLAN_PROVIDER_ID, raw, diag, rejectedAccessToken);
  if (!apiKey) return { apiKey: null };
  const refreshed = parseChatGptPlanCredential(await readStoredCredential(account, diag));
  return refreshed?.access === apiKey
    ? { apiKey, accountId: refreshed.accountId, providerData: refreshed.providerData }
    : { apiKey: null };
}
