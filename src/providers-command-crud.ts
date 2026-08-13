// src/providers-command-crud.ts, list/add/remove/hub command implementations for the providers command
import pc from 'picocolors';
import * as p from '@clack/prompts';
import {
  formatRegistryAuthLabel,
  resolveProvidersForDisplay,
  type ProviderDisplayEntry,
} from './provider-catalog.js';
import {
  listAddableTemplates,
  listVisibleOAuthTemplates,
  getTemplateById,
} from './provider-templates.js';
import { addProviderFromTemplate } from './registry/add-template.js';
import {
  removeProviderFromRegistry,
  toggleProviderEnabled,
} from './registry/crud.js';
import { loadRegistry } from './registry/io.js';
import { reconcilePendingCredentialDeletes } from './registry/credential-lifecycle.js';
import { supportsNativeOAuth } from './oauth/types.js';
import { browseAllModels } from './prompts.js';
import { cachedModelToLocal } from './registry/materialize.js';
import { loadPreferences } from './config.js';
import type { LocalProvider } from './types.js';
import {
  fmtProvider,
  fmtUrl,
  logConnected,
  logKeyStoredUnverified,
  printPanel,
  printProviderDetailPanel,
} from './ui.js';
import { providerLabel } from './providers-command-args.js';
import { runProvidersAuth, runProvidersRefreshModels } from './providers-command-auth.js';

export async function runProvidersList(): Promise<number> {
  const entries = await resolveProvidersForDisplay();
  if (entries.length === 0) {
    p.log.info('No providers configured. Run leverframe providers add or leverframe providers auth openai.');
    return 0;
  }

  console.log('');
  for (const entry of entries) {
    const status = entry.enabled ? pc.green('●') : pc.dim('○');
    console.log(
      `  ${status} ${pc.bold(entry.name)} ${pc.dim(`(${entry.id})`)} — `
      + `${entry.modelCount} model${entry.modelCount === 1 ? '' : 's'}, auth: ${entry.authLabel}`,
    );
  }
  console.log('');
  return 0;
}

/**
 * Add an API-key provider from a builtin template. Until 1.x leverframe shipped
 * only the OpenAI template, so existing muscle memory (`leverframe providers add`
 * then "OpenAI API key") still works. The menu is now built dynamically from
 * every addable API template plus the ChatGPT OAuth entry, so new builtin
 * templates (Kimi Coding Plan, Moonshot, z.ai) appear automatically without
 * further edits here.
 */
async function runTemplateAddFlow(templateId: string): Promise<number> {
  const registry = loadRegistry();
  const configuredIds = registry.providers.map(p => p.id);
  const template = listAddableTemplates(configuredIds).find(t => t.id === templateId)
    ?? getTemplateById(templateId);
  if (!template || template.authType !== 'api') {
    p.log.error(`Unknown API template: ${templateId}`);
    return 1;
  }
  if (configuredIds.includes(template.id)) {
    p.log.info(`${template.name} is already configured.`);
    return 0;
  }

  if (template.signupUrl) {
    printPanel(fmtProvider(template.name), [
      `${pc.white('Get an API key at:')} ${fmtUrl(template.signupUrl)}`,
    ]);
  }

  const apiKeyInput = await p.password({
    message: `Paste your ${template.name} API key:`,
    validate: val => val.trim() ? undefined : 'Key cannot be empty',
  });
  if (p.isCancel(apiKeyInput)) {
    p.cancel('Cancelled.');
    return 0;
  }

  const apiKey = String(apiKeyInput).trim();

  const spinner = p.spinner();
  const hasStaticFallback = template.modelSource === 'api-list'
    && (template.staticModels?.length ?? 0) > 0;
  spinner.start(template.skipKeyVerification
    ? `Saving ${template.name} API key...`
    : hasStaticFallback
      ? `Adding ${template.name}...`
      : `Testing connection to ${template.name}...`);
  const result = await addProviderFromTemplate(template, apiKey);
  spinner.stop('');

  if (!result.added) {
    p.log.error(result.error ?? 'Could not add provider.');
    if (result.hint) p.log.info(result.hint);
    return 1;
  }

  if (result.keyVerified === false) {
    logKeyStoredUnverified(template.name, result.modelCount ?? 0);
    if (result.hint) p.log.info(result.hint);
  } else {
    logConnected(template.name, result.modelCount ?? 0);
  }
  return 0;
}

interface AddMenuItem {
  value: string;
  label: string;
  hint?: string;
}

function buildProvidersAddOptions(configuredIds: Iterable<string>): AddMenuItem[] {
  const configured = new Set(configuredIds);
  const options: AddMenuItem[] = [];

  const oauthTemplates = listVisibleOAuthTemplates(configured);
  for (const tpl of oauthTemplates) {
    options.push({
      value: `oauth:${tpl.id}`,
      label: tpl.id === 'openai-oauth'
        ? 'Sign in with ChatGPT (Plus/Pro plan)'
        : `Sign in with ${tpl.name} (OAuth)`,
      hint: 'OAuth device code, no API key needed',
    });
  }

  const apiTemplates = listAddableTemplates(configured);
  for (const tpl of apiTemplates) {
    options.push({
      value: `api:${tpl.id}`,
      label: `${tpl.name} API key`,
      hint: tpl.signupUrl ?? undefined,
    });
  }

  return options;
}

export async function runProvidersAdd(): Promise<number> {
  const registry = loadRegistry();
  const configuredIds = registry.providers.map(p => p.id);
  const options = buildProvidersAddOptions(configuredIds);

  if (options.length === 0) {
    p.log.info('All builtin providers are already configured.');
    return 0;
  }

  const choice = await p.select({ message: 'Add a provider', options });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return 0;
  }

  if (choice.startsWith('oauth:')) return runProvidersAuth(choice.slice('oauth:'.length));
  if (choice.startsWith('api:')) return runTemplateAddFlow(choice.slice('api:'.length));
  return 0;
}

export async function runProvidersRemove(id: string, interactive = false): Promise<number> {
  const registry = loadRegistry();
  const provider = registry.providers.find(pr => pr.id === id);
  if (!provider) {
    p.log.error(`Provider not found: ${id}`);
    return 1;
  }

  if (interactive) {
    const confirm = await p.confirm({
      message: `Remove ${provider.name} (${id})?`,
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Cancelled.');
      return 0;
    }
  }

  const result = await removeProviderFromRegistry(id);
  if (!result.removed) {
    p.log.error(result.error ?? `Could not remove ${id}`);
    return 1;
  }

  p.log.success(`Removed ${result.name ?? id}.`);
  if (result.credentialDeleted) {
    p.log.info('Provider API key removed from credential storage.');
  }
  return 0;
}

export function providerHubChoiceValue(entry: ProviderDisplayEntry): string {
  return `provider:${entry.id}`;
}

async function runProviderDetail(id: string): Promise<'back' | 'removed'> {
  const registry = loadRegistry();
  const provider = registry.providers.find(pr => pr.id === id);
  if (!provider) return 'back';

  const modelCount = provider.modelsCache?.models.length ?? 0;
  const authLabel = formatRegistryAuthLabel(provider);
  printProviderDetailPanel(provider.name, modelCount, authLabel);

  const detailOptions: Array<{ value: string; label: string; hint?: string }> = [];
  if (modelCount > 0) {
    detailOptions.push({
      value: 'browse',
      label: 'Browse models',
      hint: `Search or browse ${modelCount} model${modelCount === 1 ? '' : 's'}`,
    });
  }
  detailOptions.push({
    value: 'refresh',
    label: 'Refresh model list',
    hint: 'Fetch latest models from the provider API',
  });
  if (supportsNativeOAuth(id) || provider.authType === 'oauth') {
    detailOptions.push({
      value: 'auth',
      label: 'Sign in again (OAuth)',
      hint: 'Refresh OAuth tokens or switch accounts',
    });
  }
  detailOptions.push(
    {
      value: 'toggle',
      label: provider.enabled ? 'Disable provider' : 'Enable provider',
      hint: provider.enabled ? 'Hide from leverframe claude picker' : 'Show in leverframe claude picker',
    },
    { value: 'remove', label: 'Remove provider', hint: 'Delete from registry and credential storage when safe' },
    { value: 'back', label: 'Back', hint: '' },
  );

  const action = await p.select({
    message: 'What would you like to do?',
    options: detailOptions,
  });
  if (p.isCancel(action) || action === 'back') return 'back';

  if (action === 'browse') {
    const cachedModels = provider.modelsCache?.models ?? [];
    const localModels = cachedModels
      .map(m => cachedModelToLocal(m, provider))
      .filter((m): m is NonNullable<typeof m> => m !== null);
    const localProvider: LocalProvider = {
      id: provider.id,
      name: provider.name,
      apiKey: '',
      models: localModels,
    };
    await browseAllModels(localProvider, loadPreferences());
    return 'back';
  }

  if (action === 'refresh') {
    await runProvidersRefreshModels(id);
    return 'back';
  }

  if (action === 'auth') {
    await runProvidersAuth(id);
    return 'back';
  }

  if (action === 'toggle') {
    try {
      const result = toggleProviderEnabled(id);
      if (result.toggled) {
        p.log.success(`${provider.name} ${result.enabled ? 'enabled' : 'disabled'}.`);
      }
      return 'back';
    } finally {
      await reconcilePendingCredentialDeletes(message => p.log.warn(message));
    }
  }

  const code = await runProvidersRemove(id, true);
  return code === 0 ? 'removed' : 'back';
}

export async function runProvidersHub(): Promise<number> {
  while (true) {
    const entries = await resolveProvidersForDisplay();
    const options: Array<{ value: string; label: string; hint?: string }> = [
      { value: 'add', label: pc.bold('+ Add a provider'), hint: '' },
    ];

    for (const entry of entries) {
      const hint = entry.id;
      const value = providerHubChoiceValue(entry);
      options.push({
        value,
        label: providerLabel(entry.name, entry.modelCount, entry.enabled),
        hint,
      });
    }

    const configuredIds = new Set(entries.map(entry => entry.id));
    if (listVisibleOAuthTemplates(configuredIds).length > 0) {
      options.push({ value: 'auth-menu', label: '→ Sign in with ChatGPT (OAuth)', hint: 'device code' });
    }
    if (entries.length > 0) {
      options.push({ value: 'refresh-all', label: '↺ Refresh all models', hint: 'Update model lists for all providers' });
    }
    options.push({ value: 'done', label: 'Done', hint: '' });

    const choice = await p.select({
      message: entries.length > 0 ? 'Your providers' : 'Get started',
      options,
    });
    if (p.isCancel(choice) || choice === 'done') {
      return 0;
    }
    if (choice === 'add') {
      await runProvidersAdd();
      continue;
    }
    if (choice === 'refresh-all') {
      await runProvidersRefreshModels();
      continue;
    }
    if (choice === 'auth-menu') {
      await runProvidersAuth('openai');
      continue;
    }
    if (typeof choice === 'string' && choice.startsWith('provider:')) {
      const id = choice.slice('provider:'.length);
      const outcome = await runProviderDetail(id);
      if (outcome === 'removed') continue;
    }
  }
}
