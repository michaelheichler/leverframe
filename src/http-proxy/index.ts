import pc from 'picocolors';
import * as p from '@clack/prompts';
import { loadPreferences } from '../config.js';
import { DEFAULT_SERVER_PORT } from '../constants.js';
import {
  fetchFreshProviderCatalog,
  resolveLocalProviderApiKey,
  type FreshCatalogUnavailable,
} from '../provider-catalog.js';
import { providersForTarget } from '../target-compatibility.js';
import type { ProxyRoute } from '../proxy.js';
import { buildHttpProxyRoutes, type HttpProxyRouteResult } from './routes.js';
import { startHttpProxy, type HttpProxyHandle } from './server.js';
import { ensureHttpProxyCaBundle } from './ca.js';
import { registerServerRuntimeState, unregisterServerRuntimeState } from '../server-runtime.js';
import { HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY } from '../env.js';
import { launcherPid, onParentExit } from './parent-watch.js';
import { getInferenceRequestLogPath, getSessionLogPath } from '../log-paths.js';
import { resolveClaudeInstallation } from '../claude-installation.js';
import { runLaunchPatchCheck } from '../patcher.js';
import { loadRegistry } from '../registry/io.js';
import { loadPricingCache } from '../registry/pricing.js';
import { buildRoutingRuntime } from '../routing-runtime.js';
import { routingPreflight } from '../routing-policy-identity.js';
import type { RoutingConfig } from '../model-routing.js';
import type { RefreshModelsResult } from '../registry/refresh-models.js';
import { scanRoutingRecovery } from '../routing-bindings.js';

export interface LoadedHttpProxyRoutes extends HttpProxyRouteResult {
  favoriteCount: number;
  freshUnavailable: FreshCatalogUnavailable[];
  routingEvidence?: { config: RoutingConfig; refresh?: RefreshModelsResult };
  recoveryEvidence?: { config: RoutingConfig; refresh?: RefreshModelsResult };
}

export async function loadHttpProxyRoutes(includeRecoveryEvidence = false, hasRecoveryState = false): Promise<LoadedHttpProxyRoutes> {
  const prefs = loadPreferences();
  const favorites = prefs.favoriteModels ?? [];
  const freshCatalog = await fetchFreshProviderCatalog({ agent: 'claude' });
  const rawCatalog = providersForTarget(freshCatalog.providers, 'claude');
  const catalog = await Promise.all(rawCatalog.map(async provider => ({
    ...provider,
    apiKey: (await resolveLocalProviderApiKey(provider)) ?? '',
  })));
  return {
    ...buildHttpProxyRoutes(catalog, favorites, prefs.modelAliases ?? []),
    favoriteCount: favorites.length,
    freshUnavailable: freshCatalog.unavailable,
    ...(prefs.routing?.enabled ? { routingEvidence: { config: prefs.routing, refresh: freshCatalog.refresh } } : {}),
    ...(includeRecoveryEvidence && (hasRecoveryState || prefs.routing?.recoveryEnabled)
      ? { recoveryEvidence: { config: prefs.routing ?? {}, refresh: freshCatalog.refresh } } : {}),
  };
}

export function formatHttpProxyModelLines(
  routes: ProxyRoute[],
  aliases: LoadedHttpProxyRoutes['aliases'] = [],
): string[] {
  if (routes.length === 0) return ['  (no routable external models)'];
  const routesById = new Map(routes.map(route => [route.aliasId, route]));
  const contextLabel = (contextWindow: number | undefined): string => {
    if (!contextWindow || contextWindow <= 0) return '';
    const scaled = contextWindow >= 1_000_000
      ? `${Number((contextWindow / 1_000_000).toFixed(2))}M`
      : contextWindow >= 1_000
        ? `${Number((contextWindow / 1_000).toFixed(1))}K`
        : String(contextWindow);
    return ` (${scaled} context)`;
  };
  return [
    ...aliases.map(alias => {
      const route = routesById.get(alias.routeId);
      return `  ${alias.name}  ${pc.dim(`${alias.displayName}${contextLabel(route?.contextWindow)} → ${alias.routeId}`)}`;
    }),
    ...routes.map(route => `  ${route.aliasId}  ${pc.dim(`${route.displayName}${contextLabel(route.contextWindow)}`)}`),
  ];
}

export function printHttpProxyModels(
  routes: ProxyRoute[],
  aliases: LoadedHttpProxyRoutes['aliases'] = [],
): void {
  console.log(pc.bold('HTTP proxy model names:'));
  for (const line of formatHttpProxyModelLines(routes, aliases)) console.log(line);
}

export function reportSkippedHttpProxyFavorites(loaded: LoadedHttpProxyRoutes): void {
  if (loaded.unavailable.length > 0) {
    p.log.warn(`${loaded.unavailable.length} saved model${loaded.unavailable.length === 1 ? '' : 's'} unavailable or missing credentials.`);
  }
  if (loaded.unsupported.length > 0) {
    p.log.warn(
      `${loaded.unsupported.length} saved model${loaded.unsupported.length === 1 ? '' : 's'} skipped — `
      + 'HTTP proxy mode supports non-Anthropic AI SDK routes only.',
    );
  }
  if (loaded.freshUnavailable.length > 0) {
    p.log.warn(
      `${loaded.freshUnavailable.length} provider${loaded.freshUnavailable.length === 1 ? '' : 's'} `
      + 'did not provide a fresh routable model list; stale metadata was not used.',
    );
  }
  if (loaded.unavailableAliases.length > 0) {
    p.log.warn(
      `${loaded.unavailableAliases.length} model alias${loaded.unavailableAliases.length === 1 ? '' : 'es'} skipped — `
      + 'its target must be an available HTTP-proxy model.',
    );
  }
}

export async function startConfiguredHttpProxy(
  port: number,
  debug = false,
  inferenceLogPath = getInferenceRequestLogPath(),
  debugLogPath?: string,
  webSocketDiagnosticsLogPath?: string,
  prepareClaude = false,
  activateRouting = false,
): Promise<{ handle: HttpProxyHandle; loaded: LoadedHttpProxyRoutes }> {
  const recovery = activateRouting ? scanRoutingRecovery() : undefined;
  const loaded = await loadHttpProxyRoutes(activateRouting, recovery?.needed === true);
  const evidence = activateRouting ? loaded.routingEvidence : undefined;
  const catalog = evidence ? await buildRoutingRuntime({ config: { ...evidence.config,
    pool: [...(evidence.config.pool ?? []), ...(recovery?.targets ?? [])] }, registry: loadRegistry(),
    pricing: loadPricingCache(), fresh: { providers: [], unavailable: loaded.freshUnavailable, refresh: evidence.refresh } }) : undefined;
  const preflight = catalog && evidence ? routingPreflight(evidence.config, catalog, recovery?.targets) : undefined;
  const recoveryEvidence = activateRouting && !evidence ? loaded.recoveryEvidence : undefined;
  const recoveryOnly = !!recoveryEvidence && (!!recovery?.needed || recoveryEvidence.config.recoveryEnabled === true);
  const recoveredCatalog = recoveryOnly && recovery?.targets.length
    ? await buildRoutingRuntime({ config: { enabled: true, pool: recovery.targets }, registry: loadRegistry(),
      pricing: loadPricingCache(), fresh: { providers: [], unavailable: loaded.freshUnavailable, refresh: recoveryEvidence?.refresh } })
    : recoveryOnly ? { generatedAt: new Date().toISOString(), models: [] } : undefined;
  const routing = catalog && evidence && preflight
    ? { config: evidence.config, catalog, workload: {}, routerTarget: preflight.target,
      acceptNewBinding: () => loadPreferences().routing?.enabled === true }
    : recoveredCatalog && recoveryEvidence ? { config: { ...recoveryEvidence.config, enabled: false },
      catalog: recoveredCatalog, workload: {}, recoveryOnly: true as const } : undefined;
  if (prepareClaude) {
    const installation = resolveClaudeInstallation();
    if (!installation) throw new Error('Claude Code installation not found for proxy preparation.');
    await runLaunchPatchCheck({
      agentStdout: true,
      installation,
      freshProviders: loaded.providers,
      contextSelectionAvailable: true,
      routingAvailable: !!preflight,
      routingConfig: routing?.config,
      routingPreflight: preflight,
      ...(recoveryOnly ? { routingRecoveryOnly: true } : {}),
    });
  }
  const handle = await startHttpProxy({
    host: '127.0.0.1',
    port,
    routes: loaded.routes,
    modelAliases: loaded.aliases,
    debug,
    debugLogPath,
    inferenceLogPath,
    webSocketDiagnosticsLogPath,
    ...(routing ? { routing } : {}),
  });
  if (preflight) handle.routingPreflight = preflight;
  handle.caCertPath = ensureHttpProxyCaBundle(
    handle.caCertPath,
    process.env['NODE_EXTRA_CA_CERTS'],
  );
  return { handle, loaded };
}

function waitForShutdown(parentPid = launcherPid()): Promise<void> {
  return new Promise(resolve => {
    const stopWatching = parentPid ? onParentExit(parentPid, () => done()) : () => {};
    const done = () => {
      stopWatching();
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

function registerProxyRuntime(handle: HttpProxyHandle): void {
  registerServerRuntimeState({
    mode: 'proxy',
    port: handle.port,
    pid: process.pid,
    caPath: handle.caCertPath,
    token: handle.token,
    anthropicPlaceholderKey: HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY,
    startedAt: new Date().toISOString(),
  });
}

export async function runHttpProxyServerCommand(
  debug = false,
  webSocketDiagnostics = false,
  port?: number,
  noDiscovery = false,
  prepareClaude = false,
): Promise<number> {
  const webSocketDiagnosticsLogPath = webSocketDiagnostics
    ? getSessionLogPath('server-websocket-diagnostics', 'jsonl')
    : undefined;
  let started: Awaited<ReturnType<typeof startConfiguredHttpProxy>>;
  try {
    started = await startConfiguredHttpProxy(
      port ?? DEFAULT_SERVER_PORT,
      debug,
      getInferenceRequestLogPath(),
      undefined,
      webSocketDiagnosticsLogPath,
      prepareClaude,
    );
  } catch (err) {
    p.log.error(`Failed to start HTTP proxy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { handle, loaded } = started;
  console.log('');
  console.log(pc.bold(pc.green('leverframe proxy-mode server running')));
  console.log(`  HTTPS_PROXY=http://127.0.0.1:${handle.port}`);
  console.log(`  HTTP_PROXY=http://127.0.0.1:${handle.port}`);
  console.log(`  NODE_EXTRA_CA_CERTS=${handle.caCertPath}`);
  console.log(`  Request log: ${handle.inferenceLogPath}`);
  if (handle.webSocketDiagnosticsLogPath) {
    console.log(`  WebSocket diagnostics: ${handle.webSocketDiagnosticsLogPath}`);
    console.log(pc.yellow('  Diagnostic mode records request headers and metadata; credential headers are redacted.'));
  }
  console.log('');
  printHttpProxyModels(loaded.routes, loaded.aliases);
  reportSkippedHttpProxyFavorites(loaded);
  console.log('');
  console.log(pc.dim('Anthropic requests keep Claude Code auth and pass through unchanged.'));
  console.log(pc.dim('Use `/model <listed-name>` for a favorite or saved alias.'));
  console.log(pc.dim('Press Ctrl+C to stop.'));

  if (!noDiscovery) registerProxyRuntime(handle);

  await waitForShutdown();
  if (!noDiscovery) unregisterServerRuntimeState();
  await handle.close();
  return 0;
}
