import * as p from '@clack/prompts';
import { OPENAI_CHATGPT_PLAN_PROVIDER_ID } from '../constants.js';
import { resolveProviderOAuthProviderData, saveProviderCredential } from '../env.js';
import { readChatGptPlanRegistration } from '../oauth/chatgpt-plan.js';
import { oauthCredentialToKeychainJson, type StoredOAuthCredential } from '../oauth/types.js';
import { loadRegistry } from './io.js';
import { withCredentialMutationLock } from './lock.js';
import type { RegistryProvider } from './types.js';

function planAccounts(provider?: RegistryProvider) {
  if (!provider) return [];
  if (provider.accounts?.length) return provider.accounts.map(account => ({
    value: account.authRef, label: account.name ?? account.id,
  }));
  return provider.authRef.startsWith('keyring:') ? [{ value: provider.authRef, label: provider.name }] : [];
}

export async function selectChatGptPlanRegistration(provider?: RegistryProvider) {
  const accounts = planAccounts(provider);
  if (!accounts.length) return undefined;
  const authRef = await p.select({
    message: 'Choose a ChatGPT plan account',
    options: [...accounts, { value: 'new', label: 'Continue with another ChatGPT account or workspace' }],
  });
  if (p.isCancel(authRef)) throw new Error('ChatGPT plan sign-in cancelled.');
  if (authRef === 'new') return undefined;
  const providerData = readChatGptPlanRegistration(await resolveProviderOAuthProviderData(authRef));
  return { authRef, providerData };
}

export async function saveChatGptPlanReauthorization(authRef: string, credential: StoredOAuthCredential): Promise<RegistryProvider> {
  return withCredentialMutationLock(authRef, async () => {
    const provider = loadRegistry().providers.find(item => item.id === OPENAI_CHATGPT_PLAN_PROVIDER_ID);
    if (!provider || !planAccounts(provider).some(account => account.value === authRef)) {
      throw new Error('The selected ChatGPT plan account no longer exists.');
    }
    const saved = readChatGptPlanRegistration(await resolveProviderOAuthProviderData(authRef));
    const replacement = readChatGptPlanRegistration(credential.providerData);
    if (saved.clientId !== replacement.clientId || saved.subject !== replacement.subject || saved.hostId !== replacement.hostId) {
      throw new Error('The ChatGPT plan registration changed during sign-in.');
    }
    if (!await saveProviderCredential(authRef, oauthCredentialToKeychainJson(credential))) {
      throw new Error('Could not save the renewed ChatGPT plan credentials.');
    }
    return provider;
  });
}
