import { loadPreferences, updateRoutingPreferences } from './config.js';
import { parseRoutingConfig } from './routing-config.js';
import type { ModelRef, RoutingCategory, RoutingConfig } from './model-routing.js';
import { fetchFreshProviderCatalog } from './provider-catalog.js';
import { loadRegistry } from './registry/io.js';
import { loadPricingCache } from './registry/pricing.js';
import { accountModelsCache } from './registry/account-cache.js';
import { buildRoutingRuntime } from './routing-runtime.js';
import { routingPreflight } from './routing-policy-identity.js';
import { runLaunchPatchCheck } from './patcher.js';
import { resolveClaudeInstallation } from './claude-installation.js';
import { checkResolvedPatchState } from './patch-reconcile.js';
import { isCurrentPatchState } from './patch-classify.js';
import { currentTransformVersion } from './patch-state.js';
import { VERSION } from './constants.js';
import { cachedSwitchyardCatalog, orderedSwitchyardModels, switchyardModelLine, switchyardPoolLines, validateSwitchyardTargets } from './cli-switchyard-catalog.js';
import { runSwitchyardMenu } from './cli-switchyard-menu.js';

export const switchyardHelp = `Usage: leverframe switchyard [enable|disable|status|costs|refresh]
  leverframe switchyard set router --provider ID --model ID
  leverframe switchyard set router-fallback --provider ID --model ID
  leverframe switchyard set CATEGORY --provider ID --model ID [--effort LEVEL]
  leverframe switchyard set deep_research --provider ID --model ID --effort LEVEL --provider ID --model ID --effort LEVEL
  leverframe switchyard billing auto|subscription-first|api-first|balanced
  router sets the preferred front target; router-fallback sets the required fallback.`;

function parseTargets(args: string[]): { providerId: string; modelId: string; effort?: string }[] {
  const arms: { providerId: string; modelId: string; effort?: string }[] = [];
  let arm: Partial<{ providerId: string; modelId: string; effort: string }> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag ?? 'option'}.`);
    if (flag === '--provider') {
      if (arm.providerId) {
        if (!arm.modelId) throw new Error('Each provider requires a model.');
        arms.push(arm as { providerId: string; modelId: string; effort?: string });
        arm = {};
      }
      arm.providerId = value;
    } else if (flag === '--model' && !arm.modelId) arm.modelId = value;
    else if (flag === '--effort' && !arm.effort) arm.effort = value;
    else throw new Error(`Invalid option ${flag}.`);
  }
  if (!arm.providerId || !arm.modelId) throw new Error('Each target requires --provider and --model.');
  arms.push(arm as { providerId: string; modelId: string; effort?: string });
  return arms;
}

function nextTarget(config: RoutingConfig, category: string, args: string[]): RoutingConfig {
  const arms = parseTargets(args);
  if (category === 'router' || category === 'router-fallback') {
    if (arms.length !== 1 || arms[0]!.effort) throw new Error('The router requires one target without effort.');
    return category === 'router' ? { ...config, cheapFloor: arms[0] } : { ...config, cheapFallback: arms[0] };
  }
  if (!category.trim()) throw new Error('A category is required.');
  const previous = config.categories?.[category] ?? {};
  let next: RoutingCategory;
  if (category === 'deep_research') {
    if (arms.length !== 2 || !arms[0]!.effort || !arms[1]!.effort) throw new Error('Deep research requires two targets with effort.');
    const { target: _target, effort: _effort, ...retained } = previous;
    next = { ...retained, alternatingTargets: arms as [ModelRef & { effort: string }, ModelRef & { effort: string }] };
  } else {
    if (arms.length !== 1) throw new Error('A category requires one target.');
    const { alternatingTargets: _alternating, ...retained } = previous;
    next = { ...retained, target: { providerId: arms[0]!.providerId, modelId: arms[0]!.modelId }, effort: arms[0]!.effort };
  }
  return { ...config, categories: { ...config.categories, [category]: next } };
}

async function freshEvidence(config: RoutingConfig) {
  const fresh = await fetchFreshProviderCatalog({ agent: 'claude' });
  const catalog = await buildRoutingRuntime({ config: { ...config, enabled: true }, fresh,
    registry: loadRegistry(), pricing: loadPricingCache() });
  const warnings = validateSwitchyardTargets(config, catalog);
  for (const warning of warnings) console.warn(warning);
  return { fresh, catalog };
}

export async function refreshSwitchyardCatalog() {
  const fresh = await fetchFreshProviderCatalog({ agent: 'claude' });
  if (!fresh.refresh) throw new Error('Provider discovery did not complete. Run provider setup and retry.');
  const registry = loadRegistry();
  const pool = registry.providers.flatMap(provider => {
    const caches = provider.accounts?.length ? provider.accounts.map(account => accountModelsCache(provider, account)) : [provider.modelsCache];
    return caches.flatMap(cache => (cache?.models ?? []).map(model => ({ providerId: provider.id, modelId: model.id })));
  });
  const catalog = await buildRoutingRuntime({ config: { enabled: true, pool }, fresh, registry,
    pricing: loadPricingCache(), includeNative: true });
  for (const provider of fresh.refresh.refreshed) {
    console.log(`${provider.id}: ${provider.ok && !provider.skipped && provider.modelSource === 'live' ? 'discovered' : 'unavailable or unverified'}`);
  }
  console.log('API-equivalent example uses one million input and one million output tokens.');
  for (const model of orderedSwitchyardModels(catalog)) console.log(switchyardModelLine(model, true));
  return catalog;
}

function timing(): void {
  console.log('New category, billing and enable settings require a new Claude launch and integration reconciliation. Disabling blocks new bindings in a running proxy now. Existing jobs retain their binding and authorized fallbacks.');
}

function status(config: RoutingConfig): void {
  console.log(`Switchyard ${config.enabled ? 'enabled' : 'disabled'} on disk. Public model ${config.visibleModelId ?? 'auto'} (${config.visibleModelLabel ?? 'Switchyard'}).`);
  const ref = (target: ModelRef | undefined) => target ? `${target.providerId}/${target.modelId}` : 'not configured';
  console.log(`Preferred router ${ref(config.cheapFloor)}, router fallback ${ref(config.cheapFallback)}. Billing preference ${config.subscriptionPreference ?? 'auto'}.`);
  for (const [name, category] of Object.entries(config.categories ?? {})) console.log(`${name}: ${JSON.stringify(category)}`);
  const preferences = loadPreferences();
  console.log(`Account pool balancing ${preferences.accountPoolBalancing ? 'enabled' : 'disabled'}, failover ${preferences.accountPoolFailover ? 'enabled' : 'disabled'}.`);
  for (const line of switchyardPoolLines()) console.log(line);
  console.log('API-equivalent example uses one million input and one million output tokens.');
  for (const model of orderedSwitchyardModels(cachedSwitchyardCatalog())) console.log(switchyardModelLine(model));
  timing();
}

function costs(): void {
  console.log('API-equivalent example uses one million input and one million output tokens. Cache components are unknown when rates are absent.');
  for (const model of orderedSwitchyardModels(cachedSwitchyardCatalog())) console.log(switchyardModelLine(model));
  console.log('Subscription consumption is unknown. Leverframe cannot verify a cheaper subscription without sourced plan metadata and a comparison assumption.');
}

export async function runSwitchyardCommand(args: string[]): Promise<number> {
  try {
    const [action, ...rest] = args;
    if (!action) return runSwitchyardMenu();
    if (action === '--help' || action === '-h' || action === 'help') { console.log(switchyardHelp); return 0; }
    if ((action === '--version' || action === '-v') && !rest.length) { console.log(VERSION); return 0; }
    if (action === 'refresh' && !rest.length) { await refreshSwitchyardCatalog(); return 0; }
    if (action === 'status' && !rest.length) { status(loadPreferences().routing ?? {}); return 0; }
    if (action === 'costs' && !rest.length) { costs(); return 0; }
    if (action === 'disable' && !rest.length) {
      updateRoutingPreferences(current => ({ ...current, enabled: false }));
      console.log('Switchyard disabled for new launches.'); timing(); return 0;
    }
    if (action === 'billing' && rest.length === 1 && ['auto', 'subscription-first', 'api-first', 'balanced'].includes(rest[0]!)) {
      updateRoutingPreferences(current => ({ ...current, subscriptionPreference: rest[0] as NonNullable<RoutingConfig['subscriptionPreference']> }),
        rest[0] === 'balanced' ? { accountPoolBalancing: true } : undefined);
      console.log(rest[0] === 'balanced' ? 'Billing preference saved. Account pool balancing is enabled now for shared pools.' : 'Billing preference saved.');
      timing(); return 0;
    }
    if (action === 'set' && rest.length > 1) {
      const category = rest[0]!;
      const snapshot = loadPreferences().routing ?? {};
      const candidate = parseRoutingConfig(nextTarget(snapshot, category, rest.slice(1)))!;
      const { catalog } = await freshEvidence(candidate);
      updateRoutingPreferences(current => {
        const next = parseRoutingConfig(nextTarget(current, category, rest.slice(1)))!;
        validateSwitchyardTargets(next, catalog);
        return next;
      });
      console.log(`Saved ${category} target.`); timing(); return 0;
    }
    if (action === 'enable' && !rest.length) {
      const snapshot = loadPreferences().routing ?? {};
      const candidate = parseRoutingConfig({ ...snapshot, enabled: true })!;
      const { fresh, catalog } = await freshEvidence(candidate);
      const preflight = routingPreflight(candidate, catalog);
      const installation = resolveClaudeInstallation();
      if (!installation) throw new Error('Routing requires a supported Claude installation.');
      await runLaunchPatchCheck({ agentStdout: true, installation, freshProviders: fresh.providers, contextSelectionAvailable: true, routingAvailable: true,
        routingConfig: candidate, routingPreflight: preflight });
      const checked = await checkResolvedPatchState(installation, undefined, fresh.providers, undefined, true, true, candidate, preflight);
      if (!isCurrentPatchState(checked.state) || !checked.manifest || checked.manifest.configHash !== checked.configHash
        || checked.manifest.transformVersion !== currentTransformVersion()) {
        throw new Error('Routing integration could not be verified. Run leverframe patch and retry.');
      }
      updateRoutingPreferences(current => {
        if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error('Routing settings changed during preparation. Retry enable. The next launch may need reconciliation.');
        return candidate;
      });
      console.log('Switchyard enabled on disk.'); timing(); return 0;
    }
    throw new Error('Invalid Switchyard command. Use leverframe switchyard --help.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
