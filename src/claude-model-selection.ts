import * as p from '@clack/prompts';
import { providerSelectOption } from './ui.js';
import { pickLocalModel } from './prompts.js';
import { recordLaunchSelection } from './config.js';
import { findProviderAndModel, type planLaunchWizard } from './launch-target.js';
import type { FreshProviderCatalog } from './provider-catalog.js';
import type { ConflictInfo, FavoriteModel, LocalProvider, LocalProviderModel, UserPreferences } from './types.js';

export interface ModelSelection { provider: LocalProvider; model: LocalProviderModel }

interface SelectionOptions {
  providers: LocalProvider[];
  unavailable: FreshProviderCatalog['unavailable'];
  plan: ReturnType<typeof planLaunchWizard>;
  favorites: FavoriteModel[];
  prefs: UserPreferences;
  conflicts: ConflictInfo[];
  dryRun: boolean;
  agentStdout: boolean;
}

async function selectFavorite(providers: LocalProvider[], favorites: FavoriteModel[]): Promise<ModelSelection | undefined> {
  const available = favorites.flatMap(favorite => {
    const provider = providers.find(item => item.id === favorite.providerId);
    const model = provider?.models.find(item => item.id === favorite.modelId);
    return provider && model ? [{ provider, model }] : [];
  });
  if (!available.length) { p.log.warn('No saved favorites are currently available.'); return; }
  const choice = await p.select<string>({ message: 'Starting model?', initialValue: '0',
    options: available.map((item, index) => ({ value: String(index),
      label: `${item.model.name || item.model.id} (${item.provider.name})`, hint: item.model.id })) });
  if (p.isCancel(choice)) { p.cancel('Cancelled.'); return; }
  return available[Number(choice)];
}

async function selectInteractive(options: SelectionOptions): Promise<ModelSelection | undefined> {
  const { providers, favorites, prefs, conflicts } = options;
  const choices = providers.map(providerSelectOption);
  if (favorites.length) choices.unshift({ value: '__favorites__', label: '⭐ Favorites Catalog', hint: `${favorites.length} saved favorites` });
  let initial = choices.some(choice => choice.value === prefs.lastProvider) ? prefs.lastProvider : choices[0]?.value;
  for (;;) {
    const chosen = await p.select<string>({ message: 'Which provider?', options: choices, initialValue: initial });
    if (p.isCancel(chosen)) { p.cancel('Cancelled.'); return; }
    if (chosen === '__favorites__') return selectFavorite(providers, favorites);
    const provider = providers.find(item => item.id === chosen);
    if (!provider) return;
    const model = await pickLocalModel(provider, conflicts, prefs);
    if (model === 'back') { initial = provider.id; continue; }
    return model ? { provider, model } : undefined;
  }
}

export async function selectEndpointModel(options: SelectionOptions): Promise<ModelSelection | number> {
  const { plan, providers, unavailable } = options;
  let selected: ModelSelection | undefined;
  if (plan.skip && plan.target) {
    selected = findProviderAndModel(providers, plan.target) ?? undefined;
    if (!selected) {
      const missing = unavailable.find(entry => entry.providerId === plan.target?.providerId
        && (!entry.modelIds || entry.modelIds.includes(plan.target?.modelId ?? '')));
      p.log.error(missing ? `Model unavailable after fresh discovery: ${plan.target.modelId}. ${missing.reason}`
        : `Provider/model not found: ${plan.target.providerId} / ${plan.target.modelId}`);
      return 1;
    }
    if (!options.agentStdout) p.log.step(`Using ${selected.model.name || selected.model.id} (${selected.provider.name})`);
  } else selected = await selectInteractive(options);
  if (!selected) return 0;
  if (!options.dryRun) recordLaunchSelection('claude', selected.provider.id, selected.model.id, options.prefs);
  return selected;
}
