import pc from 'picocolors';
import * as p from '@clack/prompts';
import { launchClaude } from './launch.js';
import { buildChildEnv } from './env.js';
import { claudeCodeClientModelId } from './context-model-id.js';
import { startProxy, startProxyCatalog, type ProxyHandle, type ProxyModelAlias, type ProxyRoute } from './proxy.js';
import { buildCatalogRoutes, canonicalCatalogModelId, makeRouteResolver } from './catalog.js';
import { prepareClaudeTraceLog } from './log-paths.js';
import { printTraceLog } from './trace-log.js';
import { resolveLocalProviderApiKey } from './provider-catalog.js';
import { isAgentStdoutMode } from './agent-io.js';
import type { ClaudeInstallation } from './claude-installation.js';
import type { FavoriteModel, LocalProvider, LocalProviderModel, UserPreferences } from './types.js';

interface CatalogLaunchOptions {
  installation: ClaudeInstallation;
  catalogRoutes: ProxyRoute[];
  modelAliases: ProxyModelAlias[];
  startingRoute: ProxyRoute;
  trace: boolean;
  claudeArgs: string[];
}

async function launchClaudeViaCatalog(options: CatalogLaunchOptions): Promise<number> {
  const { installation, catalogRoutes, modelAliases, startingRoute, trace, claudeArgs } = options;
  const canonicalAliases = catalogRoutes.flatMap(route => {
    const name = canonicalCatalogModelId(route);
    return name ? [{ name, routeId: route.aliasId }] : [];
  });
  let handle: ProxyHandle;
  try {
    handle = await startProxyCatalog(catalogRoutes, startingRoute.aliasId, trace, undefined, undefined, undefined, [...canonicalAliases, ...modelAliases]);
    p.log.info(`Switch menu active - proxy on port ${handle.port} ` + pc.dim(`(${catalogRoutes.length} model${catalogRoutes.length !== 1 ? 's' : ''} in /model)`));
  } catch (error) { p.log.error(`Failed to start proxy: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  const id = canonicalCatalogModelId(startingRoute) ?? startingRoute.aliasId;
  const model = claudeCodeClientModelId(id, startingRoute.contextWindow);
  const env = buildChildEnv(`http://127.0.0.1:${handle.port}`, id, handle.token, handle.port, undefined, true);
  env['ANTHROPIC_MODEL'] = model;
  const debugLogPath = prepareClaudeTraceLog();
  if (trace) p.log.info(`Debug log: ${debugLogPath}`);
  try { return await launchClaude({ installation, env, model, extraArgs: [...(trace ? ['--debug-file', debugLogPath] : []), ...claudeArgs] }); }
  finally { handle.close(); if (trace) printTraceLog(debugLogPath); }
}

export interface EndpointLaunchOptions {
  installation: ClaudeInstallation;
  provider: LocalProvider;
  model: LocalProviderModel;
  providers: LocalProvider[];
  favorites: FavoriteModel[];
  prefs: UserPreferences;
  dryRun: boolean;
  trace: boolean;
  claudeArgs: string[];
}

function printEndpointDryRun(options: EndpointLaunchOptions, routes?: ProxyRoute[]): void {
  const { provider, model } = options;
  console.log('');
  console.log(pc.bold(pc.cyan(routes ? '  DRY RUN - would execute (switch-menu mode):' : '  DRY RUN - would execute:')));
  console.log('');
  console.log(`  ${pc.bold('Provider:')}  ${provider.name}`);
  console.log(`  ${pc.bold(routes ? 'Starting model:' : 'Model:')} ${model.id}`);
  console.log(`  ${pc.bold('Endpoint:')} ${model.baseUrl ?? model.completionsUrl ?? '(unknown)'}`);
  if (routes) {
    console.log(`  ${pc.bold('/model catalog:')} ${routes.length} model(s)`);
    routes.forEach(route => console.log(`    ${pc.dim(route.displayName)}`));
  } else {
    console.log(`  ${pc.bold('Format:')} ${model.modelFormat} (direct passthrough)`);
    console.log(`  ${pc.bold('Key:')} ${provider.name} provider key`);
  }
  console.log('');
  console.log(pc.dim('  (dry run complete - Claude Code was NOT launched)'));
  console.log('');
}

async function launchSelectedCatalog(options: EndpointLaunchOptions): Promise<number> {
  const resolve = makeRouteResolver(options.providers);
  const startingRoute = resolve(options.provider.id, options.model.id);
  if (!startingRoute) { p.log.error('Could not resolve a proxy route for the selected model.'); return 1; }
  const { routes, droppedFavorites } = buildCatalogRoutes(startingRoute, options.favorites, resolve);
  if (droppedFavorites.length) p.log.warn(`Skipping ${droppedFavorites.length} favorite${droppedFavorites.length === 1 ? '' : 's'} that are no longer available in /model`);
  if (options.dryRun) { printEndpointDryRun(options, routes); return 0; }
  const modelAliases = (options.prefs.modelAliases ?? []).flatMap(alias => {
    const target = resolve(alias.providerId, alias.modelId);
    const route = target && routes.find(item => item.aliasId === target.aliasId);
    return route ? [{ name: alias.name, routeId: route.aliasId }] : [];
  });
  return launchClaudeViaCatalog({ ...options, catalogRoutes: routes, startingRoute, modelAliases });
}

async function launchNativeEndpoint(options: EndpointLaunchOptions): Promise<number> {
  if (options.dryRun) { printEndpointDryRun(options); return 0; }
  const { provider, model, installation, trace, claudeArgs } = options;
  const key = await resolveLocalProviderApiKey(provider);
  if (!key?.trim()) { p.log.error(`No credential found for ${provider.name}. Add a key or sign in with leverframe providers.`); return 1; }
  let handle: ProxyHandle | undefined;
  if (provider.authType === 'oauth') {
    try {
      handle = await startProxy(model.baseUrl ?? 'https://api.anthropic.com', model.id, trace, model.contextWindow,
        { providerId: provider.id, authType: 'oauth', oauthAccountId: provider.oauthAccountId, providerData: provider.providerData, modelFormat: 'anthropic' }, key);
      if (!isAgentStdoutMode()) p.log.info(`OAuth proxy started on port ${handle.port}`);
    } catch (error) { p.log.error(`Failed to start OAuth proxy: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  }
  const env = buildChildEnv(handle ? `http://127.0.0.1:${handle.port}` : model.baseUrl!, model.id, handle?.token ?? key, handle?.port, model.contextWindow);
  if (!handle) env['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'] = '1';
  const debugLogPath = prepareClaudeTraceLog();
  if (trace) p.log.info(`Debug log: ${debugLogPath}`);
  try { return await launchClaude({ installation, env, model: claudeCodeClientModelId(model.id, model.contextWindow), extraArgs: [...(trace ? ['--debug-file', debugLogPath] : []), ...claudeArgs] }); }
  finally { handle?.close(); if (trace) printTraceLog(debugLogPath); }
}

export function launchSelectedEndpoint(options: EndpointLaunchOptions): Promise<number> {
  return options.favorites.length || options.model.modelFormat === 'openai' || options.model.accountTag
    ? launchSelectedCatalog(options) : launchNativeEndpoint(options);
}
