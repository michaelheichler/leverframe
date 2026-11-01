import * as p from '@clack/prompts';
import { loadPreferences, savePreferences } from './config.js';
import { addProviderAccount, formatProviderAccounts, importProviderAccount, pinProviderAccount } from './account-management.js';
import { removeProviderAccount } from './registry/credential-lifecycle.js';
import { loadRegistry } from './registry/io.js';
import { runProvidersAuth } from './providers-command-auth.js';
import { readLatestPoolActivity } from './account-pool-activity.js';

async function manageExistingAccount(providerId: string, choice: 'pin' | 'remove', accounts: import('./registry/types.js').RegistryAccount[]): Promise<void> {
  const eligible = choice === 'pin' ? accounts.filter(account => account.enabled) : accounts;
  if (eligible.length === 0) {
    p.log.warn('No eligible accounts found.');
    return;
  }
  const account = await p.select({ message: 'Select account', options: eligible.map(item => ({ value: item.id, label: item.id })) });
  if (p.isCancel(account)) return;
  if (choice === 'pin') {
    if (!pinProviderAccount(providerId, account)) p.log.warn(`Could not pin account ${account}.`);
    return;
  }
  const confirmed = await p.confirm({ message: `Remove account ${account}?`, initialValue: false });
  if (p.isCancel(confirmed) || !confirmed) return;
  const result = await removeProviderAccount(providerId, account);
  if (result.removed) p.log.success(`Removed account ${account}.`);
  else p.log.warn(`Could not remove account ${account}.`);
  if (result.credentialDeleted) p.log.info('Account credential removed from storage.');
  if (result.error) p.log.warn(result.error);
}

export async function runAccountManagement(providerId: string): Promise<void> {
  while (true) {
    const provider = loadRegistry().providers.find(item => item.id === providerId);
    if (!provider) return;
    for (const line of formatProviderAccounts(provider, readLatestPoolActivity(providerId))) p.log.info(line);
    const choice = await p.select({
      message: 'Manage accounts',
      options: [
        { value: 'add', label: providerId === 'openai-oauth' ? 'Sign in to another ChatGPT account' : 'Add API key' },
        { value: 'import', label: providerId === 'openai-oauth' ? 'Import from ~/.codex/auth.json' : 'Import ANTHROPIC_API_KEY' },
        { value: 'pin', label: 'Pin account' },
        { value: 'remove', label: 'Remove account' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (p.isCancel(choice) || choice === 'back') return;
    try {
      if (choice === 'add' && providerId === 'openai-oauth') {
        await runProvidersAuth(providerId);
      } else if (choice === 'add') {
        const key = await p.password({ message: 'Anthropic API key:' });
        if (!p.isCancel(key) && key) {
          const id = await p.text({ message: 'Account name (optional):' });
          if (!p.isCancel(id)) await addProviderAccount(providerId, key, id);
        }
      } else if (choice === 'import') {
        const confirmed = await p.confirm({ message: providerId === 'openai-oauth'
          ? 'Import credentials from ~/.codex/auth.json?' : 'Import ANTHROPIC_API_KEY?', initialValue: false });
        if (!p.isCancel(confirmed) && confirmed) {
          const id = await p.text({ message: 'Account name (optional):' });
          if (!p.isCancel(id)) await importProviderAccount(providerId, providerId === 'openai-oauth' ? 'codex' : 'anthropic-env', id);
        }
      } else if (choice === 'pin' || choice === 'remove') {
        await manageExistingAccount(providerId, choice, provider.accounts ?? []);
      }
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

export async function runAccountPoolSettings(): Promise<void> {
  while (true) {
    const prefs = loadPreferences();
    const choice = await p.select({
      message: 'Account pool settings',
      options: [
        { value: 'balancing', label: `Account balancing: ${prefs.accountPoolBalancing ? 'on' : 'off'}` },
        { value: 'failover', label: `Quota failover: ${prefs.accountPoolFailover ? 'on' : 'off'}` },
        { value: 'summary-toggle', label: `Paid summaries: ${prefs.summarySettings?.enabled ? 'on' : 'off'}`, hint: 'Changes block new reservations. Reserved calls may finish.' },
        { value: 'summary-configure', label: 'Configure summary engine and lifetime spending limit' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (p.isCancel(choice) || choice === 'back') return;
    if (choice === 'balancing') savePreferences({ accountPoolBalancing: !prefs.accountPoolBalancing });
    if (choice === 'failover') savePreferences({ accountPoolFailover: !prefs.accountPoolFailover });
    if (choice === 'summary-toggle') savePreferences({ summarySettings: { ...prefs.summarySettings, enabled: !prefs.summarySettings?.enabled } });
    if (choice === 'summary-configure') await configureSummary();
  }
}

export function parseUsdMicros(value: string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match || match[1].length > 16) return undefined;
  const micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : undefined;
}

async function configureSummary(): Promise<void> {
  p.log.info('Use LEVERFRAME_SUMMARY_API_KEY for the selected API provider. Confirm maximum prices from the provider before enabling summaries.');
  p.log.info('Turning summaries off or lowering the limit blocks new reservations. Calls already reserved may finish.');
  const engineId = await p.text({ message: 'Engine (openai:model or anthropic-api:model):' });
  if (p.isCancel(engineId) || !/^(openai|anthropic-api):\S+$/.test(engineId)) return;
  const limit = await p.text({ message: 'Lifetime spending limit in USD:' });
  if (p.isCancel(limit)) return;
  const limitMicros = parseUsdMicros(limit);
  if (limitMicros === undefined || limitMicros === 0) return;
  const input = await p.text({ message: 'Verified maximum input price in USD per million tokens:' });
  if (p.isCancel(input)) return;
  const inputMicros = parseUsdMicros(input);
  if (inputMicros === undefined) return;
  const output = await p.text({ message: 'Verified maximum output price in USD per million tokens:' });
  if (p.isCancel(output)) return;
  const outputMicros = parseUsdMicros(output);
  if (outputMicros === undefined) return;
  const provenance = await p.text({ message: 'Source and date of verified maximum prices:' });
  if (p.isCancel(provenance) || !provenance.trim()) return;
  const previous = loadPreferences().summarySettings;
  savePreferences({ summarySettings: { enabled: previous?.enabled === true, engineId, lifetimeLimitMicros: limitMicros, pricing: { inputMicrosPerMillion: inputMicros, outputMicrosPerMillion: outputMicros, provenance } } });
}
