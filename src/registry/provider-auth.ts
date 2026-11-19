

import { printOAuthStepsPanel } from '../ui.js';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import open from 'open';
import { saveProviderCredential } from '../env.js';
import { addOAuthProviderAccount, type AccountIdentity } from '../account-management.js';
import { diagnoseCredentialStorage } from '../credential-store.js';
import {
  githubCopilotTokensToStoredCredential,
  runGitHubCopilotDeviceCodeFlow,
} from '../oauth/github-copilot.js';
import { runChatGptPlanOAuthFlow } from '../oauth/chatgpt-plan.js';
import { OPENAI_CHATGPT_PLAN_PROVIDER_ID } from '../constants.js';
import { runAntigravityOAuthFlow } from '../oauth/antigravity.js';
import { sleepMs } from '../oauth/pkce.js';
import {
  supportsNativeOAuth,
  oauthCredentialToKeychainJson,
  type NativeOAuthProviderId,
  type StoredOAuthCredential,
} from '../oauth/types.js';
import { getTemplateById } from '../provider-templates.js';
import { oauthAuthRef } from './import-build.js';
import { loadRegistry, updateRegistry } from './io.js';
import { cancelCredentialDelete, journalCredentialWrite, reconcilePendingCredentialDeletes } from './credential-lifecycle.js';
import { withCredentialMutationLock, withProviderMutationLock } from './lock.js';
import { refreshProviderModels } from './refresh-models.js';
import { saveChatGptPlanReauthorization, selectChatGptPlanRegistration } from './chatgpt-plan-account.js';
import type { RegistryProvider } from './types.js';

export type { StoredOAuthCredential } from '../oauth/types.js';

export type ProviderAuthMethod = 'native';

export interface ProviderAuthOptions {
  method?: ProviderAuthMethod;
  signal?: AbortSignal;
  accountIdentity?: AccountIdentity;
}

export interface ProviderAuthResult {
  providerId: string;
  credential: StoredOAuthCredential;
  registryProvider: RegistryProvider;
}

const PROVIDER_DISPLAY: Record<NativeOAuthProviderId, string> = {
  [OPENAI_CHATGPT_PLAN_PROVIDER_ID]: 'ChatGPT plan (Sign in with ChatGPT)',
  'github-copilot': 'GitHub Copilot',
  antigravity: 'Google Antigravity',
};

function openBrowser(url: string): void {
  const headless = process.env['SSH_CONNECTION']
    || process.env['SSH_TTY']
    || (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']);
  if (headless) return;
  open(url).catch(() => {});
}

async function runNativeDeviceCode(
  providerId: Exclude<NativeOAuthProviderId, typeof OPENAI_CHATGPT_PLAN_PROVIDER_ID>,
  signal: AbortSignal | undefined,
): Promise<StoredOAuthCredential> {
  const label = PROVIDER_DISPLAY[providerId];
  printOAuthStepsPanel(`${label}: Sign in`, label);

  const spinner = p.spinner();
  spinner.start('Waiting for authorization...');
  const onDeviceCode = ({ url, userCode }: { url: string; userCode: string }): void => {
    spinner.stop('');
    p.log.info(`Visit: ${pc.cyan(url)}`);
    p.log.info(`Enter code: ${pc.bold(userCode)}`);
    openBrowser(url);
    spinner.start('Waiting for authorization...');
  };

  try {
    if (providerId === 'antigravity') {
      const credential = await runAntigravityOAuthFlow({
        signal,
        confirmBillingRecovery: async () => {
          const answer = await p.confirm({ message: 'Antigravity reported credit use. Review Google billing before continuing. Resume subscription requests?' });
          return !p.isCancel(answer) && answer === true;
        },
        openBrowser: url => { spinner.stop(''); p.log.info(`Sign in: ${url}`); openBrowser(url); },
      });
      spinner.stop(pc.green('Signed in to Google Antigravity'));
      return credential;
    }
    const { tokens } = await runGitHubCopilotDeviceCodeFlow(onDeviceCode, {
      sleep: sleepMs,
      now: () => Date.now(),
      signal,
      onWarning: warning => {
        p.log.warn(`GitHub OAuth token polling returned HTTP ${warning.status}; retrying`);
      },
    });
    spinner.stop(pc.green('Signed in to GitHub Copilot'));
    return githubCopilotTokensToStoredCredential(tokens);
  } catch (error) {
    spinner.stop('');
    throw error;
  }
}

async function upsertOAuthProvider(registryId: string): Promise<RegistryProvider> {
  const templateId = registryId;
  return withProviderMutationLock(registryId, () => updateRegistry(registry => {
    const authRef = oauthAuthRef(registryId);
    const template = getTemplateById(templateId);
    const existing = registry.providers.find(provider => provider.id === registryId);
    let entry: RegistryProvider;
    if (existing) {
      entry = { ...existing, authType: 'oauth', authRef, templateId };
    } else {
      if (!template) {
        throw new Error(`Provider "${registryId}" is not in your registry and has no template`);
      }
      entry = {
        id: registryId,
        templateId,
        name: template.name,
        enabled: true,
        authRef,
        authType: 'oauth',
        api: {
          npm: template.npm,
          url: template.defaultBaseUrl ?? '',
          ...(template.headers ? { headers: template.headers } : {}),
        },
        addedAt: new Date().toISOString(),
      };
    }
    if (registryId === 'antigravity') {
      delete entry.modelsCache;
      delete entry.refreshedAt;
      delete entry.modelDiscoveryError;
      delete entry.modelDiscoveryWarnings;
    }
    const index = registry.providers.findIndex(provider => provider.id === registryId);
    if (index >= 0) registry.providers[index] = entry;
    else registry.providers.push(entry);
    return entry;
  }));
}

async function persistOAuthProvider(
  providerId: string,
  credential: StoredOAuthCredential,
  authRef: string,
  diagnostics: string[],
): Promise<RegistryProvider> {
  return withCredentialMutationLock(authRef, async () => {
    await journalCredentialWrite(authRef);
    const saved = await saveProviderCredential(
      authRef,
      oauthCredentialToKeychainJson(credential),
      (msg) => { diagnostics.push(msg); p.log.warn(msg); },
    );
    if (!saved) {
      throw new Error(`Could not save OAuth tokens${diagnostics.length ? ` - ${diagnostics.at(-1)}` : ' - check credential storage permissions and try again'}`);
    }
    const entry = await upsertOAuthProvider(providerId);
    try {
      await cancelCredentialDelete(authRef);
    } catch (error) {
      p.log.warn(`Could not clear credential cleanup marker: ${error instanceof Error ? error.message : String(error)}`);
    }
    return entry;
  });
}

async function authenticateChatGptPlan(options: ProviderAuthOptions) {
  const providerId = OPENAI_CHATGPT_PLAN_PROVIDER_ID;
  const existing = options.accountIdentity ? undefined : await selectChatGptPlanRegistration(
    loadRegistry().providers.find(provider => provider.id === providerId),
  );
  const credential = await runChatGptPlanOAuthFlow({
    signal: options.signal,
    existing: existing?.providerData,
    openBrowser: url => {
      p.log.info(`Continue with ChatGPT in your browser: ${url}`);
      openBrowser(url);
    },
  });
  const registryProvider = existing
    ? await saveChatGptPlanReauthorization(existing.authRef, credential)
    : await withCredentialMutationLock('chatgpt-plan-account-registration', async () => {
      const provider = loadRegistry().providers.find(item => item.id === providerId);
      if (!provider || provider.authRef === 'none:anonymous') {
        return persistOAuthProvider(providerId, credential, oauthAuthRef(providerId), []);
      }
      await addOAuthProviderAccount(providerId, oauthCredentialToKeychainJson(credential), undefined, options.accountIdentity);
      return loadRegistry().providers.find(item => item.id === providerId)!;
    });
  return { providerId, credential, registryProvider };
}

async function authenticateProviderInner(
  providerId: string,
  options: ProviderAuthOptions = {},
): Promise<ProviderAuthResult> {
  if (!supportsNativeOAuth(providerId)) {
    throw new Error(`OAuth sign-in is available for ${Object.keys(PROVIDER_DISPLAY).join(', ')}.`);
  }

  for (const diagnostic of await diagnoseCredentialStorage()) {
    if (diagnostic.level === 'warn') p.log.warn(diagnostic.message);
    else p.log.info(diagnostic.message);
  }

  const result = providerId === OPENAI_CHATGPT_PLAN_PROVIDER_ID
    ? await authenticateChatGptPlan(options)
    : await authenticateOtherOAuth(providerId, options);

  const refreshSpinner = p.spinner();
  refreshSpinner.start('Refreshing model list...');
  try {
    const refreshResult = await refreshProviderModels(providerId, result.credential.access);
    if (!refreshResult.ok || refreshResult.skipped) {
      const reason = refreshResult.reason ?? 'Model discovery failed without a reason';
      refreshSpinner.stop(`Could not refresh models: ${reason} - run leverframe providers refresh-models later`);
    } else {
      refreshSpinner.stop('Models refreshed');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    refreshSpinner.stop(`Could not refresh models: ${reason} - run leverframe providers refresh-models later`);
  }

  return result;
}

async function authenticateOtherOAuth(
  providerId: Exclude<NativeOAuthProviderId, typeof OPENAI_CHATGPT_PLAN_PROVIDER_ID>,
  options: ProviderAuthOptions,
): Promise<ProviderAuthResult> {
  const credential = await runNativeDeviceCode(providerId, options.signal);
  if (options.accountIdentity && loadRegistry().providers.some(provider => provider.id === providerId)) {
    await addOAuthProviderAccount(providerId, oauthCredentialToKeychainJson(credential), undefined, options.accountIdentity);
    const registryProvider = loadRegistry().providers.find(provider => provider.id === providerId)!;
    return { providerId, credential, registryProvider };
  }
  const registryProvider = await persistOAuthProvider(providerId, credential, oauthAuthRef(providerId), []);
  return { providerId, credential, registryProvider };
}

export async function authenticateProvider(
  providerId: string,
  options: ProviderAuthOptions = {},
): Promise<ProviderAuthResult> {
  try {
    return await authenticateProviderInner(providerId, options);
  } finally {
    await reconcilePendingCredentialDeletes(message => p.log.warn(message));
  }
}

export function providerAuthHelpText(): string {
  const providers = Object.entries(PROVIDER_DISPLAY);
  return `${pc.bold('leverframe providers auth')} - sign in with OAuth

${pc.bold('Usage:')}
${providers.map(([id]) => `  leverframe providers auth ${id}`).join('\n')}

${pc.bold('Providers:')}
${providers.map(([id, label]) => `  ${id.padEnd(15)} ${label}`).join('\n')}

GitHub Copilot uses a device code (works on SSH/VPS).
ChatGPT plan and Antigravity use browser sign-in with a local callback.`;
}
