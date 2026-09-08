import { localModelToRoute } from '../catalog.js';
import { isSdkMigratedNpm } from '../provider-factory.js';
import { claudeCodeClientModelId } from '../context-model-id.js';
import type { ProxyRoute } from '../proxy.js';
import { isValidModelAlias } from '../model-aliases.js';
import { formatModelLabel } from '../ui.js';
import type { FavoriteModel, LocalProvider, LocalProviderModel, ModelAlias } from '../types.js';

export const HTTP_PROXY_MODEL_PREFIX = 'leverframe:';

export function httpProxyModelId(providerId: string, modelId: string): string {
  return `${HTTP_PROXY_MODEL_PREFIX}${providerId}:${modelId}`;
}

export function httpProxyDisplayName(
  model: Pick<LocalProviderModel, 'id' | 'name'>,
  providerName: string,
): string {
  return `${formatModelLabel(model)} (${providerName})`;
}

export interface HttpProxyRouteResult {
  routes: ProxyRoute[];
  providers: LocalProvider[];
  unavailable: FavoriteModel[];
  unsupported: FavoriteModel[];
  aliases: ResolvedHttpProxyAlias[];
  unavailableAliases: ModelAlias[];
}

export interface ResolvedHttpProxyAlias {
  name: string;
  routeId: string;
  displayName: string;
}

export function buildHttpProxyRoutes(
  providers: LocalProvider[],
  favorites: FavoriteModel[],
  modelAliases: ModelAlias[] = [],
  max = Number.POSITIVE_INFINITY,
): HttpProxyRouteResult {
  const routes: ProxyRoute[] = [];
  const unavailable: FavoriteModel[] = [];
  const unsupported: FavoriteModel[] = [];
  const seen = new Set<string>();
  const processedModels = new Set<string>();
  const routesByModel = new Map<string, ProxyRoute>();
  const routableProviders = new Map<string, LocalProvider>();

  const modelKey = (providerId: string, modelId: string): string => `${providerId}:${modelId}`;
  const addModel = (provider: LocalProvider, model: LocalProvider['models'][number], favorite?: FavoriteModel): void => {
    const key = modelKey(provider.id, model.id);
    if (processedModels.has(key)) return;
    processedModels.add(key);

    const firstPartyAnthropic = provider.id === 'anthropic' && model.modelFormat === 'anthropic';
    const unsupportedOpenAi = model.modelFormat === 'openai' && !isSdkMigratedNpm(model.npm);
    if (firstPartyAnthropic || unsupportedOpenAi) {
      if (favorite) unsupported.push(favorite);
      return;
    }
    const route = localModelToRoute(provider, model);
    if (!route || !route.apiKey.trim()) {
      if (favorite) unavailable.push(favorite);
      return;
    }
    const aliasId = claudeCodeClientModelId(
      httpProxyModelId(provider.id, model.id),
      model.contextWindow,
    );
    if (seen.has(aliasId)) return;
    seen.add(aliasId);
    const proxyRoute = {
      ...route,
      aliasId,
      displayName: httpProxyDisplayName(model, provider.name),
    };
    routes.push(proxyRoute);
    routesByModel.set(key, proxyRoute);
    const routableProvider = routableProviders.get(provider.id);
    if (routableProvider) {
      routableProvider.models.push(model);
    } else {
      routableProviders.set(provider.id, { ...provider, models: [model] });
    }
  };

  for (const favorite of favorites) {
    if (routes.length >= max) break;
    const provider = providers.find(item => item.id === favorite.providerId);
    const model = provider?.models.find(item => item.id === favorite.modelId);
    if (!provider || !model) {
      unavailable.push(favorite);
      continue;
    }
    addModel(provider, model, favorite);
  }

  for (const provider of providers) {
    for (const model of provider.models) {
      if (routes.length >= max) break;
      addModel(provider, model);
    }
    if (routes.length >= max) break;
  }

  const aliases: ResolvedHttpProxyAlias[] = [];
  const unavailableAliases: ModelAlias[] = [];
  const seenAliases = new Set<string>();
  for (const alias of modelAliases) {
    const route = routesByModel.get(`${alias.providerId}:${alias.modelId}`);
    if (!isValidModelAlias(alias.name) || seenAliases.has(alias.name) || !route) {
      unavailableAliases.push(alias);
      continue;
    }
    seenAliases.add(alias.name);
    aliases.push({ name: alias.name, routeId: route.aliasId, displayName: route.displayName });
  }

  return {
    routes,
    providers: [...routableProviders.values()],
    unavailable,
    unsupported,
    aliases,
    unavailableAliases,
  };
}
