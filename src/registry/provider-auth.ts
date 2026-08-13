// Native provider authentication and transactional credential publication.

import { printOAuthStepsPanel } from '../ui.js';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import open from 'open';
import { saveProviderCredential } from '../env.js';
import { diagnoseCredentialStorage } from '../credential-store.js';
import {
  githubCopilotTokensToStoredCredential,
  runGitHubCopilotDeviceCodeFlow,
} from '../oauth/github-copilot.js';
import { runOpenAiDeviceCodeFlow } from '../oauth/openai.js';
import { sleepMs } from '../oauth/pkce.js';
import {
  supportsNativeOAuth,
  tokensToStoredCredential,
  oauthCredentialToKeychainJson,
  type NativeOAuthProviderId,
  type StoredOAuthCredential,
} from '../oauth/types.js';
import { getTemplateById } from '../provider-templates.js';
import { oauthAuthRef, toOAuthRegistryId } from './import-build.js';
import { updateRegistry } from './io.js';
import { cancelCredentialDelete, journalCredentialWrite, reconcilePendingCredentialDeletes } from './credential-lifecycle.js';
import { withCredentialMutationLock, withProviderMutationLock } from './lock.js';
import { refreshProviderModels } from './refresh-models.js';
import type { RegistryProvider } from './types.js';

export type { StoredOAuthCredential } from '../oauth/types.js';

export type ProviderAuthMethod = 'native';

export interface ProviderAuthOptions {
  method?: ProviderAuthMethod;
  signal?: AbortSignal;
}

export interface ProviderAuthResult {
  providerId: string;
  credential: StoredOAuthCredential;
  registryProvider: RegistryProvider;
}

const OPENAI_DISPLAY = 'OpenAI ChatGPT Plus/Pro';
const PROVIDER_DISPLAY: Record<NativeOAuthProviderId, string> = {
  openai: OPENAI_DISPLAY,
  'openai-oauth': OPENAI_DISPLAY,
  'github-copilot': 'GitHub Copilot',
};

function openBrowser(url: string): void {
  const headless = process.env['SSH_CONNECTION']
    || process.env['SSH_TTY']
    || (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']);
  if (headless) return;
  open(url).catch(() => {});
}

/** Completes one provider-specific device flow and returns a storage-ready credential. */
async function runNativeDeviceCode(
  providerId: NativeOAuthProviderId,
  signal: AbortSignal | undefined,
): Promise<StoredOAuthCredential> {
  const label = PROVIDER_DISPLAY[providerId];
  printOAuthStepsPanel(`${label} — Sign in`, label);

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
    if (providerId === 'github-copilot') {
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
    }

    const { tokens, accountId } = await runOpenAiDeviceCodeFlow(onDeviceCode);
    spinner.stop(pc.green('Signed in to OpenAI ChatGPT'));
    return tokensToStoredCredential(tokens, undefined, accountId);
  } catch (error) {
    spinner.stop('');
    throw error;
  }
}

/** Publishes an OAuth credential only after its keyring write succeeds. */
export async function saveNativeOAuthCredential(
  providerId: string,
  tokens: import('../oauth/types.js').OAuthTokenResponse,
  accountId?: string,
  providerData?: Record<string, unknown>,
): Promise<void> {
  try {
    const cred = providerId === 'github-copilot'
      ? githubCopilotTokensToStoredCredential(tokens)
      : tokensToStoredCredential(tokens, undefined, accountId, providerData);
    const registryId = toOAuthRegistryId(providerId);
    const diagnostics: string[] = [];
    const authRef = oauthAuthRef(registryId);
    await persistOAuthProvider(providerId, cred, authRef, diagnostics);
  } finally {
    await reconcilePendingCredentialDeletes(message => p.log.warn(message));
  }
}

/**
 * The OAuth provider shares a templateId with the API-key provider (openai),
 * so it needs a distinguishing display name for pickers.
 */
function oauthDisplayName(registryId: string, fallbackName: string): string {
  if (registryId === 'openai-oauth') return 'OpenAI (ChatGPT)';
  return fallbackName;
}

async function upsertOAuthProvider(providerId: string, _cred: StoredOAuthCredential): Promise<RegistryProvider> {
  const registryId = toOAuthRegistryId(providerId);
  const templateId = providerId.replace(/-oauth$/, '') || providerId;
  return withProviderMutationLock(registryId, () => updateRegistry(registry => {
    const authRef = oauthAuthRef(registryId);
    const template = getTemplateById(templateId);
    const existing = registry.providers.find(provider => provider.id === registryId);
    let entry: RegistryProvider;
    if (existing) {
      entry = { ...existing, authType: 'oauth', authRef, templateId };
    } else {
      if (!template) {
        throw new Error(`Provider "${providerId}" is not in your registry and has no template`);
      }
      entry = {
        id: registryId,
        templateId,
        name: oauthDisplayName(registryId, template.name),
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
    const entry = await upsertOAuthProvider(providerId, credential);
    try {
      await cancelCredentialDelete(authRef);
    } catch (error) {
      p.log.warn(`Could not clear credential cleanup marker: ${error instanceof Error ? error.message : String(error)}`);
    }
    return entry;
  });
}

/** Authenticates, stores, and publishes one native OAuth provider atomically. */
async function authenticateProviderInner(
  providerId: string,
  options: ProviderAuthOptions = {},
): Promise<ProviderAuthResult> {
  const registryId = toOAuthRegistryId(providerId);

  if (!supportsNativeOAuth(providerId)) {
    throw new Error('OAuth sign-in is available for openai and github-copilot.');
  }

  for (const diagnostic of await diagnoseCredentialStorage()) {
    if (diagnostic.level === 'warn') p.log.warn(diagnostic.message);
    else p.log.info(diagnostic.message);
  }

  const cred = await runNativeDeviceCode(providerId, options.signal);

  const nativeDiagnostics: string[] = [];
  const authRef = oauthAuthRef(registryId);
  const registryProvider = await persistOAuthProvider(providerId, cred, authRef, nativeDiagnostics);

  const refreshSpinner = p.spinner();
  refreshSpinner.start('Refreshing model list...');
  try {
    const refreshResult = await refreshProviderModels(registryId, cred.access);
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

  return { providerId: registryId, credential: cred, registryProvider };
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
  return `${pc.bold('leverframe providers auth')} - sign in with OAuth

${pc.bold('Usage:')}
  leverframe providers auth openai
  leverframe providers auth github-copilot

${pc.bold('Device code (works on SSH/VPS):')}
  openai          ChatGPT Plus/Pro (auth.openai.com/codex/device)
  github-copilot  GitHub Copilot subscription (github.com/login/device)`;
}
