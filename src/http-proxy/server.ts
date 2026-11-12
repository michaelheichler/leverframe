import { ANTHROPIC_API_ORIGIN } from '../constants.js';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ProxyHandle, ProxyRoute } from '../proxy.js';
import { startProxyCatalog } from '../proxy.js';
import { ensureHttpProxyCertificates } from './ca.js';
import { routeLookupIds } from '../context-model-id.js';
import type { ResolvedHttpProxyAlias } from './routes.js';
import { listenTcpServer } from '../listener-ready.js';
import type { ClaudeCodeCredentialReader } from '../claude-code-credentials.js';
import { handleMitmRequest } from './mitm.js';
import { createProxyServer } from './proxy-server.js';
import type { RoutingControlContext } from '../proxy-routing-control.js';
import { RoutingNoticeChannel } from '../routing-notice-channel.js';
import { createRoutingSelectorCall } from '../proxy-routing-selector.js';
import { readClaudeCodeAuthMaterial } from '../claude-code-credentials.js';
import { RoutingSelectorCache } from '../routing-selector-cache.js';
import { createAdapterAgent } from './adapter-agent.js';

export { shouldInterceptConnect } from './proxy-server.js';
export { createAdapterAgent, ADAPTER_MAX_SOCKETS, ADAPTER_MAX_FREE_SOCKETS, ADAPTER_IDLE_TIMEOUT_MS } from './adapter-agent.js';

export interface HttpProxyOptions {
  routing?: Omit<RoutingControlContext, 'proxyToken'>;
  host?: string;
  port?: number;
  routes: ProxyRoute[];

  modelAliases?: ResolvedHttpProxyAlias[];
  debug?: boolean;

  debugLogPath?: string;

  inferenceLogPath?: string;

  webSocketDiagnosticsLogPath?: string;

  anthropicOrigin?: string;
  nativeRoutingFetch?: typeof fetch;

  anthropicRejectUnauthorized?: boolean;

  adapterHandle?: ProxyHandle;

  adapterRequest?: typeof http.request;

  responseProgressIntervalMs?: number;

  proxyAuthToken?: string;

  resolveClaudeCodeAuth?: ClaudeCodeCredentialReader;
}

export interface HttpProxyHandle {
  routingEnabled?: true;
  routingRecoveryOnly?: true;
  routingVisibleModelId?: string;
  routingPreflight?: ReturnType<typeof import('../routing-policy-identity.js').routingPreflight>;
  host: string;
  port: number;
  caCertPath: string;

  token: string;
  modelIds: string[];
  inferenceLogPath?: string;
  webSocketDiagnosticsLogPath?: string;
  close: () => Promise<void>;
}

export function buildProxyRoutesById(
  routes: ProxyRoute[],
  modelAliases?: ResolvedHttpProxyAlias[],
): Map<string, ProxyRoute> {
  const routesById = new Map<string, ProxyRoute>();
  for (const route of routes) {
    for (const id of routeLookupIds(route.aliasId)) routesById.set(id, route);
  }
  for (const alias of modelAliases ?? []) {
    const route = routesById.get(alias.routeId);
    if (!route) continue;
    for (const id of routeLookupIds(alias.name)) routesById.set(id, route);
  }
  for (const route of routes) {
    if (route.realModelId.toLowerCase().startsWith('claude-')) continue;
    for (const id of routeLookupIds(route.realModelId)) {
      if (!routesById.has(id)) routesById.set(id, route);
    }
  }
  return routesById;
}

async function startAdapter(options: HttpProxyOptions): Promise<ProxyHandle | null> {
  if (options.adapterHandle) return options.adapterHandle;
  if (!options.routes.length) return null;
  return startProxyCatalog(
    options.routes, options.routes[0]!.aliasId, options.debug, options.inferenceLogPath,
    options.debugLogPath, options.webSocketDiagnosticsLogPath, options.modelAliases, options.routing,
  );
}

function createRuntimeRouting(options: HttpProxyOptions, origin: URL, adapter: () => ProxyHandle | null) {
  if (!options.routing) return undefined;
  const selectorCache = new RoutingSelectorCache();
  const noticeChannel = new RoutingNoticeChannel();
  return { ...options.routing,
    selectorCache, noticeChannel, inferenceLogPath: options.inferenceLogPath,
    selectorRequiresNotice: !options.routing.selectorTransport,
    selectorTransport: options.routing.selectorTransport ?? createRoutingSelectorCall(adapter, {
      catalog: options.routing.catalog, origin, readAuth: options.resolveClaudeCodeAuth ?? readClaudeCodeAuthMaterial,
      fetch: options.nativeRoutingFetch, noticeChannel, inferenceLogPath: options.inferenceLogPath,
    }) };
}

function createMitmServer(certificates: ReturnType<typeof ensureHttpProxyCertificates>, context: Parameters<typeof handleMitmRequest>[2]) {
  return https.createServer({
    key: certificates.serverKey, cert: certificates.serverCert, minVersion: 'TLSv1.2',
  }, (req, res) => { void handleMitmRequest(req, res, context); });
}

export async function startHttpProxy(options: HttpProxyOptions): Promise<HttpProxyHandle> {
  const certificates = ensureHttpProxyCertificates();
  const proxyAuthToken = options.proxyAuthToken ?? randomBytes(32).toString('base64url');
  const routesById = buildProxyRoutesById(options.routes, options.modelAliases);
  const origin = new URL(options.anthropicOrigin ?? ANTHROPIC_API_ORIGIN);
  let adapter: ProxyHandle | null = null;
  const routing = createRuntimeRouting(options, origin, () => adapter);
  const selectorCache = routing?.selectorCache;
  const noticeChannel = routing?.noticeChannel;
  const runtimeOptions = routing ? { ...options, routing } : options;
  try { adapter = await startAdapter(runtimeOptions); }
  catch (error) { selectorCache?.dispose(); noticeChannel?.dispose(); throw error; }
  const adapterAgent = createAdapterAgent();
  const mitmServer = createMitmServer(certificates, { options: runtimeOptions, routesById, adapter, adapterAgent, origin });
  const sockets = new Set<Socket>();
  const proxyServer = createProxyServer(proxyAuthToken, routesById, mitmServer, sockets, routing);
  const closeAdapter = async (): Promise<void> => {
    if (!adapter) return;
    await adapter.close();
    adapter = null;
  };
  let address;
  try {
    address = await listenTcpServer(proxyServer, options.port ?? 0, options.host ?? '127.0.0.1');
  } catch (err) {
    selectorCache?.dispose();
    noticeChannel?.dispose();
    adapterAgent.destroy();
    if (mitmServer.listening) await new Promise<void>(resolve => mitmServer.close(() => resolve()));
    await closeAdapter();
    throw err;
  }
  return {
    host: options.host ?? '127.0.0.1', port: address.port, caCertPath: certificates.caCertPath,
    token: proxyAuthToken,
    ...(routing?.config.enabled && !routing.recoveryOnly ? { routingEnabled: true as const, routingVisibleModelId: routing.config.visibleModelId ?? 'auto' }
      : routing?.recoveryOnly ? { routingRecoveryOnly: true as const } : {}),
    modelIds: [...(options.modelAliases ?? []).map(alias => alias.name), ...options.routes.map(route => route.aliasId)],
    inferenceLogPath: options.inferenceLogPath,
    webSocketDiagnosticsLogPath: options.webSocketDiagnosticsLogPath,
    close: async () => {
      selectorCache?.dispose();
      noticeChannel?.dispose();
      adapterAgent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxyServer.close(() => resolve()));
      await new Promise<void>(resolve => mitmServer.close(() => resolve()));
      await closeAdapter();
    },
  };
}
