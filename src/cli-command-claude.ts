import pc from 'picocolors';
import * as p from '@clack/prompts';
import { leverframeIntro } from './ui.js';
import { resolveClaudeInstallation } from './claude-installation.js';
import { detectConflicts } from './env.js';
import { needsFirstRunSetup, runFirstRunWizard } from './first-run.js';
import { loadPreferences, resolveBridgeMode } from './config.js';
import { fetchFreshProviderCatalog, providersForPicker, type FreshProviderCatalog } from './provider-catalog.js';
import { providersForTarget } from './target-compatibility.js';
import { setAgentStdoutMode } from './agent-io.js';
import { normalizeClaudeAgentArgs, planLaunchWizard, wantsCleanAgentStdout } from './launch-target.js';
import { runLaunchPatchCheck } from './patcher.js';
import { runClaudeHttpProxyCommand } from './claude-http-launch.js';
import { selectEndpointModel } from './claude-model-selection.js';
import { launchSelectedEndpoint } from './claude-endpoint-launch.js';
import type { ParsedArgs, UserPreferences } from './types.js';

async function loadLaunchCatalog(agentStdout: boolean): Promise<FreshProviderCatalog> {
  const spinner = agentStdout ? undefined : p.spinner();
  spinner?.start('Loading your providers...');
  try { return await fetchFreshProviderCatalog({ agent: 'claude' }); }
  finally { spinner?.stop(''); }
}

function reportEmptyCatalog(catalog: FreshProviderCatalog): void {
  if (catalog.unavailable.length) {
    p.log.error('No providers passed fresh model discovery.');
    for (const entry of catalog.unavailable) p.log.info(pc.dim(`${entry.providerName}: ${entry.reason}`));
  } else p.log.warn('No providers available.');
  p.log.info(pc.dim('Run leverframe providers to get started.'));
}

function resolveNoninteractiveTarget(plan: ReturnType<typeof planLaunchWizard>, dryRun: boolean, prefs: UserPreferences): boolean {
  if (plan.skip || process.stdin.isTTY === true) return true;
  const saved = dryRun ? loadPreferences() : prefs;
  if (saved.lastProvider && saved.lastModel) {
    plan.skip = true;
    plan.target = { providerId: saved.lastProvider, modelId: saved.lastModel };
    return true;
  }
  console.error(pc.red('\nError: interactive wizard requires a TTY. Pass --provider and --model, or run once interactively.\n'));
  return false;
}

export async function runClaudeCommand(parsed: ParsedArgs): Promise<number> {
  const { dryRun, trace } = parsed;
  const claudeArgs = normalizeClaudeAgentArgs(parsed.claudeArgs);
  const agentStdout = wantsCleanAgentStdout('claude', claudeArgs);
  setAgentStdoutMode(agentStdout);
  const installation = resolveClaudeInstallation();
  if (!installation) {
    console.error(pc.red('\nError: claude binary not found on PATH.\n'));
    console.error('Install Claude Code:');
    console.error('  npm install -g @anthropic-ai/claude-code\n');
    return 1;
  }
  const mode = resolveBridgeMode('claude', parsed.bridgeMode, { persist: Boolean(parsed.saveBridgeMode) && !dryRun });
  if (mode === 'proxy') return runClaudeHttpProxyCommand({ parsed, claudeArgs, agentStdout, installation });
  const prefs = dryRun ? {} as UserPreferences : loadPreferences();
  const plan = planLaunchWizard({ explicit: { providerId: parsed.launchProvider, modelId: parsed.launchModel },
    childArgs: claudeArgs, agent: 'claude', prefs });
  if (plan.error) { console.error(pc.red(`\nError: ${plan.error}\n`)); return 1; }
  if (!resolveNoninteractiveTarget(plan, dryRun, prefs)) return 1;
  if (!agentStdout) leverframeIntro('Claude Code');
  if (!dryRun && await needsFirstRunSetup() && await runFirstRunWizard(trace) === 'cancel') return 0;
  let catalog: FreshProviderCatalog;
  try { catalog = await loadLaunchCatalog(agentStdout); }
  catch (error) { console.error(pc.red(error instanceof Error ? error.message : String(error))); return 1; }
  const providers = providersForTarget(providersForPicker(catalog.providers), 'claude');
  if (!providers.length) { reportEmptyCatalog(catalog); return plan.target || catalog.unavailable.length ? 1 : 0; }
  const favorites = dryRun ? [] : prefs.favoriteModels ?? [];
  const selected = await selectEndpointModel({ providers, unavailable: catalog.unavailable, plan, favorites, prefs,
    conflicts: detectConflicts(), dryRun, agentStdout });
  if (typeof selected === 'number') return selected;
  try {
    await runLaunchPatchCheck({ agentStdout, dryRun, installation, freshProviders: catalog.providers,
      selectedModel: selected.model.modelFormat === 'openai' || selected.model.accountTag
        ? { providerId: selected.provider.id, modelId: selected.model.id } : undefined });
  } catch { return 1; }
  return launchSelectedEndpoint({ ...selected, providers: catalog.providers, favorites, prefs,
    installation, dryRun, trace, claudeArgs });
}
