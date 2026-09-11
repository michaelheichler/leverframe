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
import { getInferenceRequestLogPath, getSessionLogPath } from '../log-paths.js';
import { resolveClaudeInstallation } from '../claude-installation.js';
import { runLaunchPatchCheck } from '../patcher.js';

export interface LoadedHttpProxyRoutes extends HttpProxyRouteResult {
  favoriteCount: number;
  freshUnavailable: FreshCatalogUnavailable[];
}

export async function loadHttpProxyRoutes(): Promise<LoadedHttpProxyRoutes> {
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
): Promise<{ handle: HttpProxyHandle; loaded: LoadedHttpProxyRoutes }> {
  const loaded = await loadHttpProxyRoutes();
  if (prepareClaude) {
    const installation = resolveClaudeInstallation();
    if (!installation) throw new Error('Claude Code installation not found for proxy preparation.');
    await runLaunchPatchCheck({
      agentStdout: true,
      installation,
      freshProviders: loaded.providers,
      contextSelectionAvailable: true,
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
  });
  handle.caCertPath = ensureHttpProxyCaBundle(
    handle.caCertPath,
    process.env['NODE_EXTRA_CA_CERTS'],
  );
  return { handle, loaded };
}

function waitForShutdown(): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
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

  if (!noDiscovery) {
    registerServerRuntimeState({
      mode: 'proxy',
      port: handle.port,
      pid: process.pid,
      caPath: handle.caCertPath,
      token: handle.token,
      startedAt: new Date().toISOString(),
    });
  }

  await waitForShutdown();
  if (!noDiscovery) unregisterServerRuntimeState();
  await handle.close();
  return 0;
}
