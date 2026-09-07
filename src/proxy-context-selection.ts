import type { IncomingMessage, ServerResponse } from 'node:http';
import { contextSelectionOptions, type ContextSelectionOption } from './context-selection.js';
import { stripContextMarkers } from './context-model-id.js';
import { fetchFreshProviderCatalog } from './provider-catalog.js';
import { extractApiKey, sendJson } from './http-utils.js';
import { anthropicError } from './proxy-response.js';
import { aliasModelId, lookupRoute, type ProxyRoute } from './proxy-request.js';

export function applyFreshContextSelection(
  route: ProxyRoute,
  model: Pick<ContextSelectionMetadata, 'contextWindow' | 'maxContextWindow' | 'contextWindowUnconfirmed'>,
): ContextSelectionOption[] {
  const options = contextSelectionOptions(model);
  if (options.length === 0) return [];
  route.contextWindow = options[0]!.contextWindow;
  route.maxContextWindow = options.find(option => option.mode === 'maximum')?.contextWindow;
  route.contextWindowUnconfirmed = undefined;
  return options;
}

interface ContextSelectionMetadata {
  contextWindow?: number;
  maxContextWindow?: number;
  contextWindowUnconfirmed?: boolean;
}

export interface ContextSelectionHandlerOptions {
  proxyToken: string;
  byAlias: Map<string, ProxyRoute>;
  fetchFreshCatalog?: typeof fetchFreshProviderCatalog;
}

function contextModelIdCandidates(id: string): string[] {
  const bare = stripContextMarkers(id);
  const modelId = bare.startsWith('models/') ? bare.slice('models/'.length) : bare;
  const candidates = [bare, modelId];
  if (modelId.startsWith('leverframe:')) {
    const target = modelId.slice('leverframe:'.length);
    const separator = target.indexOf(':');
    if (separator > 0 && separator < target.length - 1) {
      candidates.push(aliasModelId(target.slice(separator + 1), target.slice(0, separator)));
    }
  }
  return [...new Set(candidates)];
}

function routeLookupCandidates(id: string): string[] {
  return contextModelIdCandidates(id);
}

function routeModelIds(route: ProxyRoute): string[] {
  const ids = [route.realModelId, route.aliasId];
  return [...new Set(ids.flatMap(contextModelIdCandidates))];
}

function matchesModelId(wantedIds: ReadonlySet<string>, id: string | undefined): boolean {
  return id !== undefined && contextModelIdCandidates(id).some(candidate => wantedIds.has(candidate));
}

export async function handleContextSelectionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ContextSelectionHandlerOptions,
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (requestUrl.pathname !== '/v1/leverframe/context-selection') return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { type: 'invalid_request_error', message: 'Only GET is supported.' } });
    return true;
  }
  if (extractApiKey(req) !== options.proxyToken) {
    anthropicError(res, 401, 'Invalid proxy token');
    return true;
  }
  const requestedModel = requestUrl.searchParams.get('model')?.trim();
  if (!requestedModel) {
    sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'A model query parameter is required.' } });
    return true;
  }

  const bareModelId = stripContextMarkers(requestedModel);
  const route = routeLookupCandidates(bareModelId)
    .map(candidate => lookupRoute(options.byAlias, candidate))
    .find((candidate): candidate is ProxyRoute => candidate !== undefined);
  if (!route) {
    sendJson(res, 404, { error: { type: 'not_found_error', message: 'Model was not found in the active catalog.' } });
    return true;
  }
  const providerId = route.providerId;
  if (!providerId) {
    sendJson(res, 503, { error: { type: 'invalid_request_error', message: 'Fresh model discovery is unavailable for this route.' } });
    return true;
  }

  let freshCatalog: Awaited<ReturnType<typeof fetchFreshProviderCatalog>>;
  try {
    freshCatalog = await (options.fetchFreshCatalog ?? fetchFreshProviderCatalog)({ agent: 'claude' });
  } catch {
    sendJson(res, 503, { error: { type: 'overloaded_error', message: 'Fresh model discovery failed.' } });
    return true;
  }
  const wantedIds = new Set(routeModelIds(route).concat(contextModelIdCandidates(bareModelId)));
  const provider = freshCatalog.providers.find(candidate => candidate.id === providerId);
  const freshModel = provider?.models.find(candidate =>
    [candidate.id, candidate.upstreamModelId].some(id => matchesModelId(wantedIds, id)),
  );
  const unavailable = freshCatalog.unavailable.some(item =>
    item.providerId === providerId
    && (item.modelIds === undefined || item.modelIds.some(id => matchesModelId(wantedIds, id))),
  );
  if (!freshModel || unavailable) {
    sendJson(res, 503, { error: { type: 'overloaded_error', message: 'Fresh model discovery did not confirm this model.' } });
    return true;
  }
  const selection = applyFreshContextSelection(route, freshModel);
  if (selection.length === 0) {
    sendJson(res, 503, { error: { type: 'overloaded_error', message: 'Fresh model discovery did not report a confirmed context window.' } });
    return true;
  }
  sendJson(res, 200, {
    model: route.realModelId,
    options: selection.map(option => ({
      mode: option.mode,
      contextWindow: option.contextWindow,
      label: option.label,
    })),
  });
  return true;
}
