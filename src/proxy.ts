import type { LanguageModel } from 'ai';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rememberConfiguredPool } from './account-pool-dispatch.js';
import {
claudeCodeClientModelId,
stripOneMContextSuffix,
} from './context-model-id.js';
import {
reconcileExecutionsAtStartup
} from './execution-tracking.js';
import { disposeLanguageModel } from './language-model-disposal.js';
import { listenTcpServer } from './listener-ready.js';
import {
evictResponsesWebSocketConnectionsForAccessToken
} from './oauth/responses-websocket.js';
import { ProviderRuntimeCache } from './provider-runtime-cache.js';
import { handleProxyRequest } from './proxy-handler.js';
import {
type ProxyModelAlias,
type ProxyRoute
} from './proxy-request.js';
import {
anthropicError,
makeProxyLog
} from './proxy-response.js';
import { cancelAllActiveRequestExecutions } from './request-execution-context.js';
import {
silenceSdkWarnings
} from './sdk-adapter.js';
import { formatAnthropicModelList } from './server/models.js';

export { aliasModelId,type ProxyModelAlias,type ProxyRoute } from './proxy-request.js';
export { isTransientSdkStreamFailure } from './proxy-retry.js';

const INTERNAL_ADAPTER_KEEPALIVE_TIMEOUT_MS = 60_000;

export interface ProxyHandle {
  port: number;
  token: string;
  close: () => void | Promise<void>;
}

export async function startProxyCatalog(
  routes: ProxyRoute[],
  defaultAliasId: string,
  debug = false,
  inferenceLogPath?: string,
  debugLogPath?: string,
  webSocketDiagnosticsLogPath?: string,
  modelAliases?: ProxyModelAlias[],
): Promise<ProxyHandle> {
  const proxyToken = randomUUID();
  const managedPools = configuredPools(routes);
  silenceSdkWarnings();
  const providerRuntimeCache = new ProviderRuntimeCache<LanguageModel>({
    disposeHandle: disposeLanguageModel,
    onCredentialRotated: previous => {
      evictResponsesWebSocketConnectionsForAccessToken(previous.credential);
    },
  });

  if (routes.length === 0) {
    return Promise.reject(new Error('Proxy catalog requires at least one route'));
  }

  const byAlias = makeRouteAliases(routes, modelAliases);
  const defaultRoute = byAlias.get(defaultAliasId) ?? routes[0]!;

  const plog = makeProxyLog(debug, debugLogPath);
  logStartupRecovery(plog);

  const onRejection = (reason: unknown) => {
    plog(() => `Unhandled Rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
  };
  const onException = (error: Error) => {
    plog(() => `Uncaught Exception: ${error.stack || error.message}`);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  const modelsPayload = () => proxyModelsPayload(routes);

  const server = createServer(async (req, res) => {
    try {
      plog(() => `${req.method} ${req.url}`);

      await handleProxyRequest(req, res, {
        proxyToken, byAlias, defaultRoute, managedPools, providerRuntimeCache, plog,
        modelsPayload, inferenceLogPath, webSocketDiagnosticsLogPath,
      });
    } catch (err) {
      handleProxyRequestError(res, plog, err);
    }
  });

  server.keepAliveTimeout = INTERNAL_ADAPTER_KEEPALIVE_TIMEOUT_MS;
  const cleanupListeners = () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
  let address: AddressInfo;
  try {
    address = await listenTcpServer(server, 0, '127.0.0.1');
  } catch (error) {
    cleanupListeners();
    throw error;
  }
  plog(() => `started on port ${address.port}, catalog=${routes.length} model(s), default=${defaultRoute.aliasId}`);
  return {
    port: address.port,
    token: proxyToken,
    close: async () => {
      cleanupListeners();

      cancelAllActiveRequestExecutions();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await providerRuntimeCache.dispose();
    },
  };
}

function logStartupRecovery(plog: ReturnType<typeof makeProxyLog>): void {
  const startupRecovery = reconcileExecutionsAtStartup();
  if (startupRecovery.length > 0) {
    plog(() => `execution reconciliation: ${startupRecovery.length} execution(s) require confirmation or expiry handling`);
  }
}

function configuredPools(routes: ProxyRoute[]): Set<string> {
  const managedPools = new Set<string>();
  for (const route of routes) {
    if (route.providerId && (route.authType === 'api' || route.authType === 'oauth')) {
      rememberConfiguredPool(managedPools, route.providerId, route.authType);
    }
  }
  return managedPools;
}

function makeRouteAliases(routes: ProxyRoute[], modelAliases?: ProxyModelAlias[]): Map<string, ProxyRoute> {
  const byAlias = new Map(routes.map(route => [route.aliasId, route]));
  for (const alias of modelAliases ?? []) {
    const route = byAlias.get(alias.routeId);
    if (route && !byAlias.has(alias.name)) byAlias.set(alias.name, route);
  }
  for (const route of routes) {
    if (!byAlias.has(route.realModelId)) byAlias.set(route.realModelId, route);
  }
  return byAlias;
}

function proxyModelsPayload(routes: ProxyRoute[]): string {
  return JSON.stringify(formatAnthropicModelList(routes.map(route => ({
    id: route.aliasId,
    name: route.displayName,
    contextWindow: route.contextWindow,
    contextWindowUnconfirmed: route.contextWindowUnconfirmed,
  }))));
}

function handleProxyRequestError(res: ServerResponse, plog: ReturnType<typeof makeProxyLog>, err: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const isClientError = err instanceof URIError || err instanceof SyntaxError;
  plog(() => `proxy request failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  if (!res.headersSent) {
    anthropicError(res, isClientError ? 400 : 500, isClientError
      ? `Malformed request: ${err instanceof Error ? err.message : String(err)}`
      : 'Internal proxy error');
  } else {
    try { res.end(); } catch { /* socket torn down */ }
  }
}

export function startProxy(
  completionsUrl: string,
  modelId: string,
  debug = false,
  contextWindow?: number,
  sdk?: {
    npm?: string;
    baseURL?: string;
    upstreamModelId?: string;
    providerId?: string;
    authType?: 'api' | 'oauth' | 'none';
    oauthAccountId?: string;
    providerData?: Record<string, unknown>;
    modelFormat?: 'anthropic' | 'openai';
    supportedParameters?: string[];
    reasoning?: boolean;
    supportsTemperature?: boolean;
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string;
    supportsReasoningSummaries?: boolean;
    supportsReasoningSummaryParameter?: boolean;
    supportsParallelToolCalls?: boolean;
    supportsReasoningToggle?: boolean;
    supportsPromptCacheBreakpoints?: boolean;
    interleavedReasoningField?: string;
    useResponsesLite?: boolean;
    preferWebSockets?: boolean;
    minimalClientVersion?: string;
  },
  apiKey?: string,
): Promise<ProxyHandle> {
  const bareModelId = stripOneMContextSuffix(modelId);
  const clientModelId = claudeCodeClientModelId(modelId, contextWindow);
  return startProxyCatalog([{
    aliasId: clientModelId,
    realModelId: sdk?.upstreamModelId ?? bareModelId,
    displayName: bareModelId,
    upstreamUrl: completionsUrl,
    apiKey: apiKey ?? '',
    modelFormat: sdk?.modelFormat ?? 'openai',
    contextWindow,
    npm: sdk?.npm,
    baseURL: sdk?.baseURL,
    providerId: sdk?.providerId,
    authType: sdk?.authType,
    oauthAccountId: sdk?.oauthAccountId,
    providerData: sdk?.providerData,
    supportedParameters: sdk?.supportedParameters,
    reasoning: sdk?.reasoning,
    supportsTemperature: sdk?.supportsTemperature,
    supportedReasoningEfforts: sdk?.supportedReasoningEfforts,
    defaultReasoningEffort: sdk?.defaultReasoningEffort,
    supportsReasoningSummaries: sdk?.supportsReasoningSummaries,
    supportsReasoningSummaryParameter: sdk?.supportsReasoningSummaryParameter,
    supportsParallelToolCalls: sdk?.supportsParallelToolCalls,
    supportsReasoningToggle: sdk?.supportsReasoningToggle,
    supportsPromptCacheBreakpoints: sdk?.supportsPromptCacheBreakpoints,
    interleavedReasoningField: sdk?.interleavedReasoningField,
    useResponsesLite: sdk?.useResponsesLite,
    preferWebSockets: sdk?.preferWebSockets,
    minimalClientVersion: sdk?.minimalClientVersion,
  }], clientModelId, debug);
}
