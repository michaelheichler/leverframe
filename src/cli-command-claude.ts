import pc from 'picocolors';
import * as p from '@clack/prompts';
import { leverframeIntro, providerSelectOption } from './ui.js';
import { launchClaude } from './launch.js';
import { resolveClaudeInstallation, type ClaudeInstallation } from './claude-installation.js';
import { detectConflicts, buildChildEnv, buildHttpProxyChildEnv } from './env.js';
import { claudeCodeClientModelId } from './context-model-id.js';
import { needsFirstRunSetup, runFirstRunWizard } from './first-run.js';
import { startProxy, startProxyCatalog } from './proxy.js';
import type { ProxyHandle, ProxyRoute } from './proxy.js';
import {
  buildCatalogRoutes,
  makeRouteResolver,
} from './catalog.js';
import { loadPreferences, recordLaunchSelection, resolveBridgeMode } from './config.js';
import { pickLocalModel } from './prompts.js';
import { fetchProviderCatalog, providersForPicker, resolveLocalProviderApiKey } from './provider-catalog.js';
import type { ParsedArgs, LocalProvider, LocalProviderModel } from './types.js';
import {
  getInferenceSessionLogPath,
  getSessionLogPath,
  prepareClaudeTraceLog,
} from './log-paths.js';
import {
  printTraceLog,
  writeProxyLifecycleLog,
} from './trace-log.js';
import { providersForTarget } from './target-compatibility.js';
import { setAgentStdoutMode, isAgentStdoutMode } from './agent-io.js';
import {
  findProviderAndModel,
  normalizeClaudeAgentArgs,
  planLaunchWizard,
  wantsCleanAgentStdout,
} from './launch-target.js';
import {
  loadHttpProxyRoutes,
  printHttpProxyModels,
  reportSkippedHttpProxyFavorites,
  startConfiguredHttpProxy,
} from './http-proxy/index.js';
import { runLaunchPatchCheck } from './patcher.js';

interface CatalogLaunchOptions {
  installation: ClaudeInstallation;
  catalogRoutes: ProxyRoute[];
  startingRoute: ProxyRoute;
  contextWindow: number | undefined;
  trace: boolean;
  claudeArgs: string[];
}

async function launchClaudeViaCatalog(options: CatalogLaunchOptions): Promise<number> {
  const { installation, catalogRoutes, startingRoute, contextWindow, trace, claudeArgs } = options;
  let proxyHandle: ProxyHandle;
  try {
    proxyHandle = await startProxyCatalog(catalogRoutes, startingRoute.aliasId, trace);
    p.log.info(
      `Switch menu active — proxy on port ${proxyHandle.port} ` +
      pc.dim(`(${catalogRoutes.length} model${catalogRoutes.length !== 1 ? 's' : ''} in /model)`),
    );
  } catch (err) {
    p.log.error(`Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const childEnv = buildChildEnv(
    `http://127.0.0.1:${proxyHandle.port}`,
    startingRoute.aliasId,
    proxyHandle.token,
    proxyHandle.port,
    contextWindow,
    true,
  );

  const debugLogPath = prepareClaudeTraceLog();
  const traceArgs = trace ? ['--debug-file', debugLogPath] : [];
  if (trace) p.log.info(`Debug log: ${debugLogPath}`);

  try {
    const exitCode = await launchClaude({
      installation,
      env: childEnv,
      model: claudeCodeClientModelId(startingRoute.aliasId, contextWindow),
      extraArgs: [...traceArgs, ...claudeArgs],
    });
    return exitCode;
  } finally {
    proxyHandle.close();
    if (trace) printTraceLog(debugLogPath);
  }
}

interface HttpProxyLaunchOptions {
  installation: ClaudeInstallation;
  parsed: ParsedArgs;
  claudeArgs: string[];
  agentStdout: boolean;
}

async function runClaudeHttpProxyCommand(options: HttpProxyLaunchOptions): Promise<number> {
  const { installation, parsed, claudeArgs, agentStdout } = options;
  if (parsed.launchProvider || parsed.launchModel) {
    p.log.error('--provider/--model select endpoint-mode routes and cannot be combined with --proxy.');
    p.log.info('Use `-- --model leverframe:<provider-id>:<model-id>` to start on a listed proxy-mode favorite.');
    return 1;
  }

  if (!agentStdout) leverframeIntro('Claude Code — Proxy Mode');

  if (parsed.dryRun) {
    try {
      const loaded = await loadHttpProxyRoutes();
      console.log('');
      console.log(pc.bold(pc.cyan('  DRY RUN — proxy bridge mode')));
      console.log('  ANTHROPIC_BASE_URL is not set by leverframe.');
      console.log('  HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:<random-port>');
      console.log('  NODE_EXTRA_CA_CERTS=~/.leverframe/http-proxy/leverframe-ca.pem');
      console.log('');
      printHttpProxyModels(loaded.routes, loaded.aliases);
      reportSkippedHttpProxyFavorites(loaded);
      console.log('');
      return 0;
    } catch (err) {
      p.log.error(`Could not load proxy models: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const inferenceLogPath = getInferenceSessionLogPath('claude-http-proxy');
  const proxyDebugLogPath = parsed.trace ? getSessionLogPath('claude-proxy-debug') : undefined;
  let started: Awaited<ReturnType<typeof startConfiguredHttpProxy>>;
  try {
    started = await startConfiguredHttpProxy(0, parsed.trace, inferenceLogPath, proxyDebugLogPath);
  } catch (err) {
    p.log.error(`Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { handle, loaded } = started;
  const inheritedProxyPort = (() => {
    const value = process.env['HTTPS_PROXY'] ?? process.env['HTTP_PROXY']
      ?? process.env['https_proxy'] ?? process.env['http_proxy'];
    if (!value) return undefined;
    try {
      const parsedUrl = new URL(value);
      return (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost') && parsedUrl.port
        ? Number(parsedUrl.port)
        : undefined;
    } catch {
      return undefined;
    }
  })();
  writeProxyLifecycleLog(inferenceLogPath, {
    event: 'proxy_started',
    pid: process.pid,
    parentPid: process.ppid,
    host: handle.host,
    port: handle.port,
    inheritedProxyPort,
  });
  let cleanlyStopped = false;
  const onProcessExit = (exitCode: number) => {
    if (cleanlyStopped) return;
    writeProxyLifecycleLog(inferenceLogPath, {
      event: 'proxy_process_exit',
      pid: process.pid,
      parentPid: process.ppid,
      port: handle.port,
      exitCode,
      reason: 'process exited before proxy cleanup completed',
    });
  };
  process.once('exit', onProcessExit);
  if (!agentStdout) {
    p.log.info(`Proxy started on port ${handle.port}; Claude Code's Anthropic auth remains active.`);
    p.log.info(`Inference request log: ${handle.inferenceLogPath}`);
    printHttpProxyModels(loaded.routes, loaded.aliases);
    reportSkippedHttpProxyFavorites(loaded);
    if (loaded.routes.length > 0) {
      p.log.info('Switch with `/model <listed-name>`.');
    }
  }

  const childEnv = buildHttpProxyChildEnv(handle.port, handle.caCertPath, handle.token);
  const debugLogPath = parsed.trace
    ? prepareClaudeTraceLog(getSessionLogPath('claude-debug'))
    : undefined;
  const traceArgs = debugLogPath ? ['--debug-file', debugLogPath] : [];
  if (debugLogPath && !agentStdout) {
    p.log.info(`Claude debug log: ${debugLogPath}`);
    if (proxyDebugLogPath) p.log.info(`Adapter debug log: ${proxyDebugLogPath}`);
  }

  try {
    const exitCode = await launchClaude({
      installation,
      env: childEnv,
      model: undefined,
      extraArgs: [...traceArgs, ...claudeArgs],
    });
    if (debugLogPath) printTraceLog(debugLogPath);
    return exitCode;
  } finally {
    writeProxyLifecycleLog(inferenceLogPath, {
      event: 'proxy_stopping',
      pid: process.pid,
      parentPid: process.ppid,
      port: handle.port,
      reason: 'Claude child exited',
    });
    await handle.close();
    cleanlyStopped = true;
    process.off('exit', onProcessExit);
    writeProxyLifecycleLog(inferenceLogPath, {
      event: 'proxy_stopped',
      pid: process.pid,
      parentPid: process.ppid,
      port: handle.port,
    });
  }
}

export async function runClaudeCommand(parsed: ParsedArgs): Promise<number> {
  const { dryRun, trace, launchProvider, launchModel } = parsed;
  const claudeArgs = normalizeClaudeAgentArgs(parsed.claudeArgs);
  const agentStdout = wantsCleanAgentStdout('claude', claudeArgs);
  setAgentStdoutMode(agentStdout);

  const installation = resolveClaudeInstallation();
  if (!installation) {
    console.error(pc.red('\nError: claude binary not found on PATH.\n'));
    console.error('Install Claude Code:');
    console.error('  npm install -g @anthropic-ai/claude-code\n');
    return 1;
  }

  const bridgeMode = resolveBridgeMode('claude', parsed.bridgeMode, {
    persist: Boolean(parsed.saveBridgeMode) && !dryRun,
  });

  // Launch-time patch check: prompt on TTY, notice otherwise. Never blocks the launch.
  await runLaunchPatchCheck({ agentStdout, dryRun, installation });

  if (bridgeMode === 'proxy') {
    return runClaudeHttpProxyCommand({ parsed, claudeArgs, agentStdout, installation });
  }

  const prefs = dryRun ? {} as ReturnType<typeof loadPreferences> : loadPreferences();
  const conflicts = detectConflicts();

  const favorites = dryRun ? [] : (prefs.favoriteModels ?? []);
  const launchPlan = planLaunchWizard({
    explicit: { providerId: launchProvider, modelId: launchModel },
    childArgs: claudeArgs,
    agent: 'claude',
    prefs,
  });
  if (launchPlan.error) {
    console.error(pc.red(`\nError: ${launchPlan.error}\n`));
    return 1;
  }
  // Without a TTY the interactive wizard cannot run, fall back to the last-used
  // provider/model (like print mode) instead of crashing on a clack prompt.
  if (!launchPlan.skip && process.stdin.isTTY !== true) {
    const savedPrefs = dryRun ? loadPreferences() : prefs;
    if (savedPrefs.lastProvider && savedPrefs.lastModel) {
      launchPlan.skip = true;
      launchPlan.target = { providerId: savedPrefs.lastProvider, modelId: savedPrefs.lastModel };
    } else {
      console.error(pc.red('\nError: interactive wizard requires a TTY. Pass --provider and --model, or run once interactively.\n'));
      return 1;
    }
  }
  const switchMenuActive = favorites.length > 0 && !launchPlan.skip;

  if (!agentStdout) leverframeIntro('Claude Code');

  if (!dryRun && await needsFirstRunSetup()) {
    const firstRun = await runFirstRunWizard(trace);
    if (firstRun === 'cancel') return 0;
  }

  let catalog: Awaited<ReturnType<typeof fetchProviderCatalog>>;
  if (agentStdout) {
    try {
      catalog = await fetchProviderCatalog();
    } catch (err) {
      console.error(pc.red(String(err instanceof Error ? err.message : err)));
      return 1;
    }
  } else {
    const catalogSpinner = p.spinner();
    catalogSpinner.start('Loading your providers...');
    try {
      catalog = await fetchProviderCatalog();
    } catch (err) {
      catalogSpinner.stop('');
      console.error(pc.red(String(err instanceof Error ? err.message : err)));
      return 1;
    }
    catalogSpinner.stop('');
  }

  const allProviders = providersForTarget(providersForPicker(catalog), 'claude');
  if (allProviders.length === 0) {
    p.log.warn('No providers available.');
    p.log.info(pc.dim('Run leverframe providers to get started.'));
    return 0;
  }

  const providerOptions = allProviders.map(lp => providerSelectOption(lp));

  if (switchMenuActive) {
    providerOptions.unshift({
      value: '__favorites__',
      label: '⭐ Favorites Catalog',
      hint: `${favorites.length} saved favorites`,
    });
  }

  const initialProvider =
    prefs.lastProvider && providerOptions.some(o => o.value === prefs.lastProvider)
      ? prefs.lastProvider
      : providerOptions[0]!.value;

  let activeProvider: LocalProvider;
  let selectedModel: LocalProviderModel;

  if (launchPlan.skip && launchPlan.target) {
    const resolved = findProviderAndModel(allProviders, launchPlan.target);
    if (!resolved) {
      p.log.error(
        `Provider/model not found: ${launchPlan.target.providerId} / ${launchPlan.target.modelId}`,
      );
      return 1;
    }
    activeProvider = resolved.provider;
    selectedModel = resolved.model;
    if (!agentStdout) {
      p.log.step(`Using ${selectedModel.name || selectedModel.id} (${activeProvider.name})`);
    }
    if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
  } else {
    let currentInitialProvider = initialProvider;
    while (true) {
      const chosen = await p.select<string>({
        message: 'Which provider?',
        options: providerOptions,
        initialValue: currentInitialProvider,
      });

      if (p.isCancel(chosen)) {
        p.cancel('Cancelled.');
        return 0;
      }

      const providerChoice = chosen as string;

      if (providerChoice === '__favorites__') {
        const available: Array<{ provider: LocalProvider; model: LocalProviderModel }> = [];
        for (const fav of favorites) {
          const prov = allProviders.find(lp => lp.id === fav.providerId);
          const mod = prov?.models.find(m => m.id === fav.modelId);
          if (prov && mod) available.push({ provider: prov, model: mod });
        }
        if (available.length === 0) {
          p.log.warn('No saved favorites are currently available.');
          return 0;
        }
        const favOptions = available.map((f, i) => ({
          value: String(i),
          label: `${f.model.name || f.model.id} — ${f.provider.name}`,
          hint: f.model.id,
        }));
        const pickedIdx = await p.select<string>({
          message: 'Starting model?',
          options: favOptions,
          initialValue: '0',
        });
        if (p.isCancel(pickedIdx)) { p.cancel('Cancelled.'); return 0; }
        const sel = available[Number(pickedIdx)]!;
        activeProvider = sel.provider;
        selectedModel = sel.model;
        if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
        break;
      } else {
        activeProvider = allProviders.find(lp => lp.id === providerChoice)!;
        const pickedModelResult = await pickLocalModel(activeProvider, conflicts, prefs);
        if (pickedModelResult === 'back') {
          currentInitialProvider = activeProvider.id;
          continue;
        }
        if (!pickedModelResult) return 0;
        selectedModel = pickedModelResult;

        if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
        break;
      }
    }
  }

  const localProviders = catalog.length > 0 ? catalog : null;
  if (switchMenuActive) {
    const resolveRoute = makeRouteResolver(
      localProviders,
    );
    const startingRoute = resolveRoute(activeProvider.id, selectedModel.id) ?? null;
    if (!startingRoute) {
      p.log.error('Could not resolve a proxy route for the selected model.');
      return 1;
    }
    const { routes: catalogRoutes, droppedFavorites } = buildCatalogRoutes(startingRoute, favorites, resolveRoute);
    if (droppedFavorites.length > 0) {
      p.log.warn(
        `Skipping ${droppedFavorites.length} favorite${droppedFavorites.length === 1 ? '' : 's'} `
        + 'that are no longer available in /model',
      );
    }

    if (dryRun) {
      const endpoint = selectedModel.baseUrl ?? selectedModel.completionsUrl ?? '(unknown)';
      console.log('');
      console.log(pc.bold(pc.cyan('  DRY RUN — would execute (switch-menu mode):')));
      console.log('');
      console.log(`  ${pc.bold('Provider:')}      ${activeProvider.name}`);
      console.log(`  ${pc.bold('Starting model:')} ${selectedModel.id}`);
      console.log(`  ${pc.bold('Endpoint:')}      ${endpoint}`);
      console.log(`  ${pc.bold('/model catalog:')} ${catalogRoutes.length} model(s)`);
      catalogRoutes.forEach(r => console.log(`    ${pc.dim(r.displayName)}`));
      console.log('');
      console.log(pc.dim('  (dry run complete — Claude Code was NOT launched)'));
      console.log('');
      return 0;
    }

    return launchClaudeViaCatalog({
      installation,
      catalogRoutes,
      startingRoute,
      contextWindow: selectedModel.contextWindow,
      trace,
      claudeArgs,
    });
  }

  // ── Single-model path ──

  if (dryRun) {
    const formatDesc = selectedModel.modelFormat === 'anthropic'
      ? 'direct passthrough'
      : 'via SDK adapter proxy';
    const endpoint = selectedModel.modelFormat === 'anthropic'
      ? (selectedModel.baseUrl ?? '(unknown)')
      : (selectedModel.npm ?? 'SDK');
    console.log('');
    console.log(pc.bold(pc.cyan('  DRY RUN — would execute:')));
    console.log('');
    console.log(`  ${pc.bold('Provider:')}  ${activeProvider.name}`);
    console.log(`  ${pc.bold('Model:')}     ${selectedModel.id}`);
    console.log(`  ${pc.bold('Format:')}    ${selectedModel.modelFormat} (${formatDesc})`);
    console.log(`  ${pc.bold(selectedModel.modelFormat === 'anthropic' ? 'Endpoint:' : 'SDK npm:')} ${endpoint}`);
    console.log(`  ${pc.bold('Key:')}       ${activeProvider.name} provider key`);
    console.log('');
    console.log(pc.dim('  (dry run complete — Claude Code was NOT launched)'));
    console.log('');
    return 0;
  }

  const launchApiKey = await resolveLocalProviderApiKey(activeProvider);
  if (!launchApiKey?.trim()) {
    p.log.error(
      `No credential found for ${activeProvider.name}. Add a key or sign in with leverframe providers.`,
    );
    return 1;
  }

  let proxyHandle: ProxyHandle | null = null;
  let childEnv: NodeJS.ProcessEnv;

  const isOAuthAnthropic = selectedModel.modelFormat === 'anthropic' && activeProvider.authType === 'oauth';

  if (isOAuthAnthropic) {
    // Anthropic OAuth passthrough, proxy injects compatibility metadata and Bearer auth.
    try {
      proxyHandle = await startProxy(
        selectedModel.baseUrl ?? 'https://api.anthropic.com',
        selectedModel.id,
        trace,
        selectedModel.contextWindow,
        {
          providerId: activeProvider.id,
          authType: 'oauth',
          oauthAccountId: activeProvider.oauthAccountId,
          providerData: activeProvider.providerData,
          modelFormat: 'anthropic',
        },
        launchApiKey,
      );
      if (!isAgentStdoutMode()) p.log.info(`OAuth proxy started on port ${proxyHandle.port}`);
    } catch (err) {
      p.log.error(`Failed to start OAuth proxy: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    childEnv = buildChildEnv(
      `http://127.0.0.1:${proxyHandle.port}`,
      selectedModel.id,
      proxyHandle.token,
      proxyHandle.port,
      selectedModel.contextWindow,
    );
  } else if (selectedModel.modelFormat === 'anthropic') {
    childEnv = buildChildEnv(
      selectedModel.baseUrl!,
      selectedModel.id,
      launchApiKey,
      undefined,
      selectedModel.contextWindow,
    );
  } else {
    try {
      proxyHandle = await startProxy(
        selectedModel.completionsUrl ?? '',
        selectedModel.id,
        trace,
        selectedModel.contextWindow,
        {
          npm: selectedModel.npm,
          baseURL: selectedModel.apiBaseUrl,
          upstreamModelId: selectedModel.upstreamModelId,
          providerId: activeProvider.id,
          authType: activeProvider.authType,
          oauthAccountId: activeProvider.oauthAccountId,
          supportedParameters: selectedModel.supportedParameters,
          reasoning: selectedModel.reasoning,
          interleavedReasoningField: selectedModel.interleavedReasoningField,
          useResponsesLite: selectedModel.useResponsesLite,
          preferWebSockets: selectedModel.preferWebSockets,
        },
        launchApiKey,
      );
      if (!isAgentStdoutMode()) {
        p.log.info(
          `SDK adapter proxy started on port ${proxyHandle.port}` +
          (selectedModel.npm ? pc.dim(` (${selectedModel.npm})`) : ''),
        );
      }
    } catch (err) {
      p.log.error(`Failed to start SDK adapter proxy: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    childEnv = buildChildEnv(
      `http://127.0.0.1:${proxyHandle.port}`,
      selectedModel.id,
      proxyHandle.token,
      proxyHandle.port,
      selectedModel.contextWindow,
    );
  }

  if (selectedModel.modelFormat === 'anthropic' && !isOAuthAnthropic) {
    childEnv['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'] = '1';
  }

  const debugLogPath = prepareClaudeTraceLog();
  const traceArgs = trace ? ['--debug-file', debugLogPath] : [];
  if (trace) p.log.info(`Debug log: ${debugLogPath}`);

  const exitCode = await launchClaude({
    installation,
    env: childEnv,
    model: claudeCodeClientModelId(selectedModel.id, selectedModel.contextWindow),
    extraArgs: [...traceArgs, ...claudeArgs],
  });
  proxyHandle?.close();
  if (trace) printTraceLog(debugLogPath);
  return exitCode;
}
