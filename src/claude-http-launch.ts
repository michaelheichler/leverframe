import pc from 'picocolors';
import * as p from '@clack/prompts';
import { leverframeIntro } from './ui.js';
import { launchClaude } from './launch.js';
import type { ClaudeInstallation } from './claude-installation.js';
import type { ParsedArgs } from './types.js';
import { buildHttpProxyChildEnv, withProxyAnthropicOriginSettings } from './env.js';
import { getInferenceSessionLogPath, getSessionLogPath, prepareClaudeTraceLog } from './log-paths.js';
import { printTraceLog, writeProxyLifecycleLog } from './trace-log.js';
import { loadHttpProxyRoutes, printHttpProxyModels, reportSkippedHttpProxyFavorites, startConfiguredHttpProxy } from './http-proxy/index.js';
import type { HttpProxyHandle } from './http-proxy/server.js';
import { runLaunchPatchCheck } from './patcher.js';

interface HttpProxyLaunchOptions {
  installation: ClaudeInstallation;
  parsed: ParsedArgs;
  claudeArgs: string[];
  agentStdout: boolean;
}

function ensureLoopbackNoProxy(env: NodeJS.ProcessEnv): void {
  const entries = [...new Set([env['NO_PROXY'], env['no_proxy']]
    .flatMap(value => value?.split(',') ?? []).map(value => value.trim()).filter(Boolean))];
  for (const host of ['127.0.0.1', 'localhost']) if (!entries.includes(host)) entries.push(host);
  env['NO_PROXY'] = entries.join(',');
  env['no_proxy'] = entries.join(',');
}

async function dryRunHttpProxy(options: HttpProxyLaunchOptions): Promise<number> {
  try {
    const loaded = await loadHttpProxyRoutes();
    await runLaunchPatchCheck({ agentStdout: options.agentStdout, dryRun: true,
      installation: options.installation, freshProviders: loaded.providers, contextSelectionAvailable: true });
    console.log('');
    console.log(pc.bold(pc.cyan('  DRY RUN - proxy bridge mode')));
    console.log('  ANTHROPIC_BASE_URL=https://api.anthropic.com (pinned so Claude settings cannot hijack MITM routing).');
    console.log('  HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:<random-port>');
    console.log('  NODE_EXTRA_CA_CERTS=~/.leverframe/http-proxy/leverframe-ca.pem');
    console.log('');
    printHttpProxyModels(loaded.routes, loaded.aliases);
    reportSkippedHttpProxyFavorites(loaded);
    console.log('');
    return 0;
  } catch (error) {
    p.log.error(`Could not load proxy models: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function inheritedLoopbackProxyPort(): number | undefined {
  const value = process.env['HTTPS_PROXY'] ?? process.env['HTTP_PROXY'] ?? process.env['https_proxy'] ?? process.env['http_proxy'];
  if (!value) return;
  try {
    const url = new URL(value);
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port ? Number(url.port) : undefined;
  } catch { return; }
}

function observeProxyLifecycle(handle: HttpProxyHandle, path: string): () => Promise<void> {
  writeProxyLifecycleLog(path, { event: 'proxy_started', pid: process.pid, parentPid: process.ppid,
    host: handle.host, port: handle.port, inheritedProxyPort: inheritedLoopbackProxyPort() });
  let stopped = false;
  const onProcessExit = (exitCode: number) => {
    if (!stopped) writeProxyLifecycleLog(path, { event: 'proxy_process_exit', pid: process.pid, parentPid: process.ppid,
      port: handle.port, exitCode, reason: 'process exited before proxy cleanup completed' });
  };
  process.once('exit', onProcessExit);
  return async () => {
    writeProxyLifecycleLog(path, { event: 'proxy_stopping', pid: process.pid, parentPid: process.ppid,
      port: handle.port, reason: 'Claude child exited' });
    await handle.close();
    stopped = true;
    process.off('exit', onProcessExit);
    writeProxyLifecycleLog(path, { event: 'proxy_stopped', pid: process.pid, parentPid: process.ppid, port: handle.port });
  };
}

async function launchHttpProxyChild(options: HttpProxyLaunchOptions, handle: HttpProxyHandle, proxyDebugLogPath?: string): Promise<number> {
  const env = buildHttpProxyChildEnv(handle.port, handle.caCertPath, handle.token);
  ensureLoopbackNoProxy(env);
  env['LEVERFRAME_CONTEXT_SELECTION_BASE_URL'] = `http://127.0.0.1:${handle.port}`;
  env['LEVERFRAME_CONTEXT_SELECTION_TOKEN'] = handle.token;
  const debugLogPath = options.parsed.trace ? prepareClaudeTraceLog(getSessionLogPath('claude-debug')) : undefined;
  if (debugLogPath && !options.agentStdout) {
    p.log.info(`Claude debug log: ${debugLogPath}`);
    if (proxyDebugLogPath) p.log.info(`Adapter debug log: ${proxyDebugLogPath}`);
  }
  const exitCode = await launchClaude({ installation: options.installation, env, model: undefined,
    extraArgs: [...(debugLogPath ? ['--debug-file', debugLogPath] : []), ...withProxyAnthropicOriginSettings(options.claudeArgs)] });
  if (debugLogPath) printTraceLog(debugLogPath);
  return exitCode;
}

export async function runClaudeHttpProxyCommand(options: HttpProxyLaunchOptions): Promise<number> {
  const { parsed, agentStdout, installation } = options;
  if (parsed.launchProvider || parsed.launchModel) {
    p.log.error('--provider/--model select endpoint-mode routes and cannot be combined with --proxy.');
    p.log.info('Use `-- --model leverframe:<provider-id>:<model-id>` to start on a listed proxy-mode favorite.');
    return 1;
  }
  if (!agentStdout) leverframeIntro('Claude Code - Proxy Mode');
  if (parsed.dryRun) return dryRunHttpProxy(options);
  const inferenceLogPath = getInferenceSessionLogPath('claude-http-proxy');
  const proxyDebugLogPath = parsed.trace ? getSessionLogPath('claude-proxy-debug') : undefined;
  let started: Awaited<ReturnType<typeof startConfiguredHttpProxy>>;
  try { started = await startConfiguredHttpProxy(0, parsed.trace, inferenceLogPath, proxyDebugLogPath); }
  catch (error) {
    p.log.error(`Failed to start proxy: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { handle, loaded } = started;
  try { await runLaunchPatchCheck({ agentStdout, dryRun: false, installation, freshProviders: loaded.providers, contextSelectionAvailable: true }); }
  catch { await handle.close(); return 1; }
  const stop = observeProxyLifecycle(handle, inferenceLogPath);
  if (!agentStdout) {
    p.log.info(`Proxy started on port ${handle.port}; Claude Code's Anthropic auth remains active.`);
    p.log.info(`Inference request log: ${handle.inferenceLogPath}`);
    printHttpProxyModels(loaded.routes, loaded.aliases);
    reportSkippedHttpProxyFavorites(loaded);
    if (loaded.routes.length > 0) p.log.info('Switch with `/model <listed-name>`.');
  }
  try { return await launchHttpProxyChild(options, handle, proxyDebugLogPath); }
  finally { await stop(); }
}
