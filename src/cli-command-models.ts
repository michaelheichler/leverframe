import pc from 'picocolors';
import * as p from '@clack/prompts';
import { leverframeIntro, leverframeOutro, providerSelectOption, modelSelectOption, fmtModel, fmtEnabledStar } from './ui.js';
import { loadPreferences, savePreferences } from './config.js';
import { fetchProviderCatalog, providersForPicker } from './provider-catalog.js';
import { MAX_MODEL_CATALOG } from './constants.js';
import type { FavoriteModel, LocalProvider, LocalProviderModel } from './types.js';
import { addFavorite, removeFavorite, isFavorite } from './favorites.js';
import { canonicalizeModelAliasName, modelAliasTarget, parseModelAliasAssignment } from './model-aliases.js';
import { contextCeilingCandidates, findContextCeilingCandidate } from './context-ceilings.js';
import {
  browseByProviderChoice,
  buildGlobalFavoriteIndex,
  pickGlobalFavoriteModel,
} from './favorites-picker.js';
import { favoriteProviderDisplayName } from './favorite-provider-display.js';
import {
  loadHttpProxyRoutes,
  printHttpProxyModels,
  reportSkippedHttpProxyFavorites,
} from './http-proxy/index.js';

interface FavoritesCommandOptions {
  list?: boolean;
  alias?: string;
  unalias?: string;
  contextCeiling?: string;
  noContextCeiling?: string;
}

/**
 * Opt a model in or out of its documented context ceiling. Only ids with a
 * ceiling on record are accepted, so this can never assert a window Leverframe
 * has no basis for.
 */
function runContextCeilingChange(modelId: string, enable: boolean): number {
  const id = modelId.trim().toLowerCase();
  const candidate = findContextCeilingCandidate(id);
  if (candidate === undefined) {
    p.log.error(`${modelId} reports no context window above the one its provider serves.`);
    const available = contextCeilingCandidates();
    if (available.length === 0) {
      p.log.info('No configured model currently reports a higher maximum. Refresh provider models and retry.');
    } else {
      p.log.info('Models that do:');
      for (const entry of available) {
        p.log.info(
          `  ${entry.modelId} (${entry.providerName}): `
          + `${entry.contextWindow.toLocaleString('en-US')} → ${entry.maxContextWindow.toLocaleString('en-US')}`,
        );
      }
    }
    return 1;
  }
  const ceiling = candidate.maxContextWindow;
  const current = loadPreferences().contextCeilingOverrides ?? [];
  const without = current.filter(entry => entry.toLowerCase() !== id);
  if (enable) {
    if (without.length !== current.length) {
      p.log.info(`${id} already uses its ${ceiling.toLocaleString('en-US')}-token ceiling.`);
      return 0;
    }
    savePreferences({ contextCeilingOverrides: [...without, id] });
    p.log.success(`${id} now uses its ${ceiling.toLocaleString('en-US')}-token ceiling.`);
    p.log.info('Run `leverframe patch` to apply it to Claude Code.');
    return 0;
  }
  if (without.length === current.length) {
    p.log.error(`${id} is not opted in to a context ceiling.`);
    return 1;
  }
  savePreferences({ contextCeilingOverrides: without });
  p.log.success(`${id} now uses the window its provider reports.`);
  p.log.info('Run `leverframe patch` to apply it to Claude Code.');
  return 0;
}

export async function runModelsCommand(opts: FavoritesCommandOptions = {}): Promise<number> {
  if (opts.contextCeiling !== undefined && opts.noContextCeiling !== undefined) {
    p.log.error('--context-ceiling and --no-context-ceiling apply one at a time.');
    return 1;
  }
  if (opts.contextCeiling !== undefined) return runContextCeilingChange(opts.contextCeiling, true);
  if (opts.noContextCeiling !== undefined) return runContextCeilingChange(opts.noContextCeiling, false);
  const changesAlias = opts.alias !== undefined || opts.unalias !== undefined;
  if (changesAlias && (opts.list || (opts.alias !== undefined && opts.unalias !== undefined))) {
    p.log.error('--alias/--unalias apply one at a time to proxy-mode favorites.');
    return 1;
  }
  if (opts.alias !== undefined) {
    const parsed = parseModelAliasAssignment(opts.alias);
    if ('error' in parsed) {
      p.log.error(parsed.error);
      return 1;
    }
    const prefs = loadPreferences();
    const isSavedFavorite = (prefs.favoriteModels ?? []).some(
      favorite => favorite.providerId === parsed.providerId && favorite.modelId === parsed.modelId,
    );
    if (!isSavedFavorite) {
      p.log.error(`${modelAliasTarget(parsed)} is not a saved favorite.`);
      p.log.info('Add it with `leverframe models`, then save the alias.');
      return 1;
    }
    const modelAliases = (prefs.modelAliases ?? []).filter(alias => alias.name !== parsed.name);
    modelAliases.push(parsed);
    savePreferences({ modelAliases });
    p.log.success(`Saved model alias ${parsed.name} → ${modelAliasTarget(parsed)}.`);
    return 0;
  }
  if (opts.unalias !== undefined) {
    const name = canonicalizeModelAliasName(opts.unalias);
    if (name === null) {
      p.log.error('Alias names must be 1-64 letters, numbers, dots, underscores, or hyphens.');
      return 1;
    }
    const prefs = loadPreferences();
    const aliases = prefs.modelAliases ?? [];
    const modelAliases = aliases.filter(alias => alias.name !== name);
    if (modelAliases.length === aliases.length) {
      p.log.error(`No model alias named ${name} is saved.`);
      return 1;
    }
    savePreferences({ modelAliases });
    p.log.success(`Removed model alias ${name}.`);
    return 0;
  }
  if (opts.list) {
    try {
      const loaded = await loadHttpProxyRoutes();
      printHttpProxyModels(loaded.routes, loaded.aliases);
      reportSkippedHttpProxyFavorites(loaded);
      return 0;
    } catch (err) {
      p.log.error(`Could not load proxy models: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const maxFavorites = MAX_MODEL_CATALOG;
  const scopeName = 'Favorite Models';
  leverframeIntro(scopeName);

  const spinner = p.spinner();
  spinner.start('Loading providers...');

  const catalog = await fetchProviderCatalog();
  spinner.stop('');

  const allProviders = providersForPicker(catalog);
  const favoriteProviders = allProviders.map(provider => ({
    ...provider,
    name: favoriteProviderDisplayName(provider),
  }));

  if (favoriteProviders.length === 0) {
    p.log.warn('No providers found.');
    p.log.info(`${pc.dim('Add a provider with ')}${pc.cyan('leverframe providers')}${pc.dim('.')}`);
    leverframeOutro('Done');
    return 0;
  }

  // Build a flat name lookup: "providerId:modelId" → display label
  const modelLookup = new Map<string, { modelName: string; providerName: string }>();
  for (const ap of favoriteProviders) {
    for (const m of ap.models) {
      modelLookup.set(`${ap.id}:${m.id}`, { modelName: m.name || m.id, providerName: ap.name });
    }
  }

  const prefs = loadPreferences();
  let favorites = prefs.favoriteModels ?? [];
  let favoritesDirty = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    type MenuChoice = string;
    const options: Array<{ value: MenuChoice; label: string; hint: string }> = [];

    // One entry per saved favorite. selecting it removes it
    for (let i = 0; i < favorites.length; i++) {
      const fav = favorites[i]!;
      const entry = modelLookup.get(`${fav.providerId}:${fav.modelId}`);
      const label = entry
        ? `${fmtEnabledStar(true)} ${fmtModel(entry.modelName)} ${pc.dim(`(${entry.providerName})`)}`
        : pc.dim(`★ ${fav.modelId} — provider gone`);
      options.push({ value: `fav-${i}`, label, hint: 'select to remove' });
    }

    const atCap = favorites.length >= maxFavorites;
    options.push({
      value: '__add__',
      label: atCap ? pc.dim(`+ Add a model → (limit of ${maxFavorites} reached)`) : pc.cyan('+ Add a model →'),
      hint: atCap
        ? 'Remove a favorite first to make room'
        : `${allProviders.length} provider${allProviders.length !== 1 ? 's' : ''} available`,
    });
    options.push({ value: '__done__', label: 'Done', hint: '' });

    const header = favorites.length === 0
      ? `${scopeName} (0/${maxFavorites})`
      : `${scopeName} (${favorites.length}/${maxFavorites}) — select to remove`;

    const choice = await p.select<string>({
      message: header,
      options,
      initialValue: '__done__',
    });

    if (p.isCancel(choice) || choice === '__done__') break;

    if (choice === '__add__') {
      if (atCap) {
        p.log.warn(`Limit of ${maxFavorites} favorites reached — remove one first.`);
        continue;
      }

      const globalCount = buildGlobalFavoriteIndex(favoriteProviders).length;
      const addPath = await p.select<string>({
        message: 'Add a favorite',
        options: [
          {
            value: 'global',
            label: pc.cyan('Search all providers'),
                hint: `${globalCount} models · ${favoriteProviders.length} provider${favoriteProviders.length !== 1 ? 's' : ''}`,
          },
          {
            value: 'provider',
            label: pc.cyan('Browse by provider →'),
            hint: 'Pick one provider first',
          },
        ],
      });
      if (p.isCancel(addPath)) continue;

      let provider: LocalProvider | undefined;
      let browsedMultiple: LocalProviderModel[] = [];

      if (addPath === 'global') {
        const globalPick = await pickGlobalFavoriteModel(favoriteProviders, favorites);
        if (globalPick === null) continue;
        if (globalPick !== browseByProviderChoice) {
          provider = favoriteProviders.find(ap => ap.id === globalPick.providerId);
          browsedMultiple = [globalPick.model];
        }
      }

      if (browsedMultiple.length === 0) {
        let currentInitialProvider: string | undefined = undefined;
        while (true) {
          const providerOptions = favoriteProviders.map(ap => providerSelectOption(ap));
          const pickedProviderId: string | symbol = await p.select({
            message: 'Which provider?',
            options: providerOptions,
            initialValue: currentInitialProvider,
          });
          if (p.isCancel(pickedProviderId)) break;

          provider = favoriteProviders.find(ap => ap.id === pickedProviderId)!;

          const options = provider.models.map(m => {
            const favorited = isFavorite(favorites, { providerId: provider!.id, modelId: m.id });
            return modelSelectOption(m, favorited ? pc.yellow('★ already favorite') : '');
          });

          const pickedModelIds = await p.multiselect({
            message: `Select models to add from ${provider.name} ${pc.dim('(Space to select, Enter to confirm)')}`,
            options,
            required: false,
          });

          if (p.isCancel(pickedModelIds)) {
            currentInitialProvider = provider.id;
            continue;
          }

          if (pickedModelIds.length === 0) {
            currentInitialProvider = provider.id;
            continue;
          }

          browsedMultiple = provider.models.filter(m => (pickedModelIds as string[]).includes(m.id));
          break;
        }
        if (browsedMultiple.length === 0) continue;
      }

      const addedModels: LocalProviderModel[] = [];
      let duplicateCount = 0;
      let limitReached = false;

      for (const model of browsedMultiple) {
        const fav: FavoriteModel = { providerId: provider!.id, modelId: model.id };
        const result = addFavorite(favorites, fav, maxFavorites);
        if (!result.ok) {
          if (result.reason === 'duplicate') {
            duplicateCount++;
          } else {
            limitReached = true;
            break;
          }
        } else {
          favorites = result.list;
          favoritesDirty = true;
          addedModels.push(model);
        }
      }

      if (addedModels.length > 0) {
        if (addedModels.length === 1) {
          const modelName = addedModels[0].name || addedModels[0].id;
          p.log.success(`Added ${modelName} (${provider!.name}) to favorites.`);
        } else {
          p.log.success(`Added ${addedModels.length} models from ${provider!.name} to favorites.`);
        }
      }
      if (duplicateCount > 0) {
        p.log.warn(`${duplicateCount} selected model(s) were already in your favorites.`);
      }
      if (limitReached) {
        p.log.warn(`Limit of ${maxFavorites} favorites reached — some selected models could not be added.`);
      }
    } else if ((choice as string).startsWith('fav-')) {
      const idx = parseInt((choice as string).slice(4), 10);
      const fav = favorites[idx]!;
      const entry = modelLookup.get(`${fav.providerId}:${fav.modelId}`);
      const label = entry ? `${entry.modelName} (${entry.providerName})` : fav.modelId;
      const confirmed = await p.confirm({ message: `Remove ${label} from favorites?` });
      if (p.isCancel(confirmed) || !confirmed) continue;
      favorites = removeFavorite(favorites, fav);
      favoritesDirty = true;
      p.log.success(`Removed ${label} from favorites.`);
    }
  }

  if (favoritesDirty) {
    savePreferences({ favoriteModels: favorites });
  }

  leverframeOutro(
    favorites.length === 0
      ? 'No favorites saved'
      : `${favorites.length} favorite${favorites.length !== 1 ? 's' : ''} saved`,
    favorites.length === 0
      ? pc.dim('Launch uses single-model mode')
      : pc.cyan('/model menu ready on next launch'),
  );
  return 0;
}
