
import { MAX_MODEL_CATALOG } from './constants.js';
import { claudeCodeClientModelId } from './context-model-id.js';
import { isSdkMigratedNpm } from './provider-factory.js';
import { aliasModelId } from './proxy.js';
import type { ProxyRoute } from './proxy.js';
import type { FavoriteModel, LocalProvider, LocalProviderModel } from './types.js';

export function canonicalCatalogModelId(
  route: Pick<ProxyRoute, 'aliasId' | 'providerId'>,
): string | undefined {
  if (!route.providerId) return undefined;
  const alias = route.aliasId.replace(/\[1m\]$/i, '');
  if (alias.startsWith('leverframe:')) return alias;
  const separator = alias.indexOf('__');
  const modelId = separator >= 0 ? alias.slice(separator + 2) : alias;
  if (!modelId) return undefined;
  return `leverframe:${route.providerId}:${modelId}`;
}

export function localModelToRoute(lp: LocalProvider, model: LocalProviderModel): ProxyRoute | null {
  if (model.modelFormat === 'anthropic' && !model.baseUrl) return null;
  if (model.modelFormat === 'openai' && !isSdkMigratedNpm(model.npm) && !model.completionsUrl) return null;
  const upstreamUrl = model.modelFormat === 'anthropic' ? model.baseUrl : model.completionsUrl;
  return {
    aliasId: claudeCodeClientModelId(aliasModelId(model.id, lp.id), model.contextWindow),
    realModelId: model.upstreamModelId,
    displayName: `${model.name || model.id} (${lp.name})`,
    upstreamUrl: upstreamUrl ?? '',
    apiKey: lp.apiKey,
    modelFormat: model.modelFormat,
    contextWindow: model.contextWindow,
    maxContextWindow: model.maxContextWindow,
    inputTokenLimit: model.inputTokenLimit,
    outputTokenLimit: model.outputTokenLimit,
    minimalClientVersion: model.minimalClientVersion,
    contextWindowUnconfirmed: model.contextWindowUnconfirmed,
    npm: model.npm,
    baseURL: model.apiBaseUrl,
    providerId: lp.id,
    authType: lp.authType,
    oauthAccountId: lp.oauthAccountId,
    providerData: lp.providerData,
    headers: lp.headers,
    supportedParameters: model.supportedParameters,
    reasoning: model.reasoning,
    supportsTemperature: model.supportsTemperature,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportsReasoningSummaries: model.supportsReasoningSummaries,
    supportsReasoningSummaryParameter: model.supportsReasoningSummaryParameter,
    supportsParallelToolCalls: model.supportsParallelToolCalls,
    supportsReasoningToggle: model.supportsReasoningToggle,
    supportsPromptCacheBreakpoints: model.supportsPromptCacheBreakpoints,
    interleavedReasoningField: model.interleavedReasoningField,
    useResponsesLite: model.useResponsesLite,
    preferWebSockets: model.preferWebSockets,
  };
}

export function makeRouteResolver(
  localProviders: LocalProvider[] | null,
): (providerId: string, modelId: string) => ProxyRoute | undefined {
  return (providerId, modelId) => {
    const provider = localProviders?.find(lp => lp.id === providerId);
    const model = provider?.models.find(m => m.id === modelId);
    return provider && model ? localModelToRoute(provider, model) ?? undefined : undefined;
  };
}

export function buildCatalogRoutes(
  startingRoute: ProxyRoute,
  favorites: FavoriteModel[],
  resolveRoute: (providerId: string, modelId: string) => ProxyRoute | undefined,
  max = MAX_MODEL_CATALOG,
): { routes: ProxyRoute[]; droppedFavorites: FavoriteModel[] } {
  const droppedFavorites: FavoriteModel[] = [];
  const tail = favorites
    .map(fav => {
      const route = resolveRoute(fav.providerId, fav.modelId);
      if (!route) droppedFavorites.push(fav);
      return route;
    })
    .filter((route): route is ProxyRoute => route !== undefined);
  const routes = [
    startingRoute,
    ...tail.filter(route => route.aliasId !== startingRoute.aliasId),
  ].slice(0, max);
  return { routes, droppedFavorites };
}
