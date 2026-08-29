import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBinaryOnPath } from '../src/binary-lookup.js';
import { resolveClaudeInstallation } from '../src/claude-installation.js';
import { readManifestV2 } from '../src/patch-state.js';
import { getCredentialFallbackPath } from '../src/credential-fallback-store.js';
import { isZeroCost } from '../src/free-models.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { findClaudeBinary } from '../src/launch.js';
import { getProvidersPath } from '../src/paths.js';
import { fetchProviderCatalog, resolveLocalProviderApiKey } from '../src/provider-catalog.js';
import { isSdkMigratedNpm } from '../src/provider-factory.js';
import { loadRegistry } from '../src/registry/io.js';
import { providersForTarget } from '../src/target-compatibility.js';
import type { FavoriteModel, LocalProvider, LocalProviderModel } from '../src/types.js';

/** Disposable copy of the resolved claude binary, patched instead of the real one. */
let stagedClaudeBinary: string | null = null;

const PROMPT = 'Reply with exactly one word: OK';
const LIVE_TIMEOUT_MS = 120_000;
const VITEST_TIMEOUT_MS = LIVE_TIMEOUT_MS + 30_000;
const SKIP_ENV = 'LEVERFRAME_SKIP_LIVE_PROVIDER_SMOKE';
const FORCE_ENV = 'LEVERFRAME_LIVE_PROVIDER_SMOKE';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_BIN = join(homedir(), '.local', 'bin');
const ANTHROPIC_HAIKU = 'claude-haiku-4-5-20251001';

const PREFERRED_CHEAPEST: Record<string, string> = {
  anthropic: ANTHROPIC_HAIKU,
  'openai-oauth': 'gpt-5.6-luna',
  'opencode-go': 'hy3',
  'github-copilot': 'mai-code-1.1-flash',
};

const QUOTA_PATTERN = /out of quota|weekly limit|usage limit|monthly usage limit|rate limit|overloaded|credit balance|billing|too many requests|\b429\b|hit your[\s\S]{0,40}limit/i;
const LEVERFRAME_FAULT_PATTERN = /failed to start proxy|could not load proxy models|provider\/model not found|claude binary not found|cannot be combined with --proxy|no routable favorite|could not resolve a proxy route|failed to start oauth proxy|failed to start sdk adapter proxy|injected claude has no v2 patch state|cannot be recovered safely|execution error leverframe/i;
const PROXY_OAUTH_FAULT_PATTERN = /oauth refresh|invalid_grant|not logged in|please (run |use )?\/login|authentication required|missing credentials|\bunauthorized\b/i;

interface SmokeCase {
  providerId: string;
  providerName: string;
  modelId: string;
  modelRef: string;
  passthrough: boolean;
}

interface SpawnSmokeResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
}

type SmokeKind =
  | 'pass-ok'
  | 'pass-quota'
  | 'fail-timeout'
  | 'fail-leverframe'
  | 'fail-claude'
  | 'fail-crash';

interface LivePlan {
  runLive: boolean;
  skipReason?: string;
  forceFailReason?: string;
  cases: SmokeCase[];
}

function isRoutingQuotaPass(text: string): boolean {
  return QUOTA_PATTERN.test(text);
}

function isOkReply(text: string): boolean {
  return /\bOK\b/i.test(text);
}

function redactSmokeOutput(text: string): string {
  const ansiEscape = String.fromCharCode(0x1b);
  return text
    .replace(new RegExp(`${ansiEscape}\\[[0-9;]*[A-Za-z]`, 'g'), '')
    .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer [redacted]')
    .replace(/\bsk-ant-[A-Za-z0-9\-_]+/g, '[redacted-key]')
    .replace(/\bsk-[A-Za-z0-9\-_]+/g, '[redacted-key]')
    .replace(/\b(x-api-key|api[_-]?key)["']?\s*[:=]\s*["']?\S+/gi, '$1=[redacted]')
    .replace(/\b(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY)=\S+/g, '$1=[redacted]');
}

function redactedSnippet(stdout: string, stderr: string, max = 400): string {
  const compact = redactSmokeOutput(`${stdout}\n${stderr}`).replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `…${compact.slice(-max)}`;
}

function cheapnessRank(providerId: string, model: LocalProviderModel): [number, number] {
  const id = model.id.toLowerCase();
  if (model.isFree || isZeroCost(model.cost)) return [1, 0];
  if (model.cost) return [2, model.cost.input + model.cost.output];
  let heuristic = 50;
  if (/haiku|flash|mini|luna|nano|hy3|turbo/.test(id)) heuristic = 10;
  else if (/sonnet|codex/.test(id)) heuristic = 40;
  else if (/opus|max|\bpro\b/.test(id)) heuristic = 80;
  if (providerId === 'github-copilot' && /flash|mini/.test(id)) heuristic = Math.min(heuristic, 8);
  if (providerId === 'anthropic' && /haiku/.test(id)) heuristic = Math.min(heuristic, 8);
  return [3, heuristic];
}

function pickCheapestModel(
  providerId: string,
  models: LocalProviderModel[],
): LocalProviderModel | undefined {
  if (models.length === 0) return undefined;
  const preferred = PREFERRED_CHEAPEST[providerId];
  const preferredHit = preferred ? models.find(model => model.id === preferred) : undefined;
  if (preferredHit) return preferredHit;
  const scored = models.map(model => ({ model, rank: cheapnessRank(providerId, model) }));
  scored.sort((left, right) => {
    if (left.rank[0] !== right.rank[0]) return left.rank[0] - right.rank[0];
    if (left.rank[1] !== right.rank[1]) return left.rank[1] - right.rank[1];
    return left.model.id.localeCompare(right.model.id);
  });
  return scored[0]?.model;
}

function isProxyRoutable(provider: LocalProvider, model: LocalProviderModel): boolean {
  if (provider.id === 'anthropic' && model.modelFormat === 'anthropic') return false;
  if (model.modelFormat === 'openai' && !isSdkMigratedNpm(model.npm)) return false;
  return true;
}

function classifySmokeResult(result: SpawnSmokeResult, modelRef: string): SmokeKind {
  const combined = `${result.stdout}\n${result.stderr}\n${result.spawnError ?? ''}`;
  if (isRoutingQuotaPass(combined)) return 'pass-quota';
  if (isOkReply(combined)) return 'pass-ok';
  if (LEVERFRAME_FAULT_PATTERN.test(combined)) return 'fail-leverframe';
  if (modelRef.startsWith('leverframe:') && /unknown model/i.test(combined)) return 'fail-leverframe';
  if (modelRef.startsWith('leverframe:') && PROXY_OAUTH_FAULT_PATTERN.test(combined)) return 'fail-leverframe';
  if (result.spawnError) return 'fail-crash';
  if (result.timedOut) return 'fail-timeout';
  if (result.signal && result.signal !== 'SIGTERM') return 'fail-crash';
  return 'fail-claude';
}

function runtimeHomeEnv(): NodeJS.ProcessEnv {
  const live = process.env['LEVERFRAME_LIVE_HOME']?.trim();
  if (live) return { ...process.env, LEVERFRAME_HOME: live };
  const override = process.env['LEVERFRAME_HOME']?.trim();
  if (override && !override.startsWith(tmpdir())) {
    return { ...process.env, LEVERFRAME_HOME: override };
  }
  const env = { ...process.env };
  delete env['LEVERFRAME_HOME'];
  return env;
}

function withRuntimeHomeEnv<T>(fn: () => T): T {
  const previous = process.env['LEVERFRAME_HOME'];
  const runtime = runtimeHomeEnv();
  if (runtime['LEVERFRAME_HOME']) process.env['LEVERFRAME_HOME'] = runtime['LEVERFRAME_HOME'];
  else delete process.env['LEVERFRAME_HOME'];
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = previous;
  }
}

async function withRuntimeHomeEnvAsync<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env['LEVERFRAME_HOME'];
  const runtime = runtimeHomeEnv();
  if (runtime['LEVERFRAME_HOME']) process.env['LEVERFRAME_HOME'] = runtime['LEVERFRAME_HOME'];
  else delete process.env['LEVERFRAME_HOME'];
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = previous;
  }
}

function resolveLeverframeCli(): { file: string; prefixArgs: string[] } | null {
  const fromPath = findBinaryOnPath('leverframe', [join(LOCAL_BIN, 'leverframe')]);
  if (fromPath) return { file: fromPath, prefixArgs: [] };
  const distCli = join(REPO_ROOT, 'dist', 'cli.js');
  if (existsSync(distCli)) return { file: process.execPath, prefixArgs: [distCli] };
  return null;
}

function resolveClaudeCli(): string | null {
  return withRuntimeHomeEnv(() => findClaudeBinary());
}

function anthropicPassthroughCase(): SmokeCase {
  return {
    providerId: 'anthropic-passthrough',
    providerName: 'Anthropic (Claude Code auth)',
    modelId: ANTHROPIC_HAIKU,
    modelRef: ANTHROPIC_HAIKU,
    passthrough: true,
  };
}

async function discoverSmokeCases(): Promise<SmokeCase[]> {
  const catalog = providersForTarget(
    await fetchProviderCatalog({ agent: 'claude' }),
    'claude',
  );
  const cases: SmokeCase[] = [];
  for (const provider of catalog) {
    const hasCredential = Boolean((await resolveLocalProviderApiKey(provider))?.trim());
    if (!hasCredential) continue;
    const passthrough = provider.id === 'anthropic';
    const pool = passthrough
      ? provider.models
      : provider.models.filter(model => isProxyRoutable(provider, model));
    const model = pickCheapestModel(provider.id, pool);
    if (!model) continue;
    cases.push({
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      modelRef: passthrough ? model.id : httpProxyModelId(provider.id, model.id),
      passthrough,
    });
  }
  if (cases.every(item => item.providerId !== 'anthropic') && resolveClaudeCli()) {
    cases.unshift(anthropicPassthroughCase());
  }
  return cases;
}

function gatedPlan(force: boolean, reason: string): LivePlan {
  if (force) return { runLive: false, forceFailReason: reason, cases: [] };
  return { runLive: false, skipReason: reason, cases: [] };
}

async function buildLivePlan(): Promise<LivePlan> {
  if (process.env[SKIP_ENV] === '1') {
    return { runLive: false, skipReason: `${SKIP_ENV}=1`, cases: [] };
  }
  const force = process.env[FORCE_ENV] === '1';
  const claude = resolveClaudeCli();
  const leverframe = resolveLeverframeCli();
  const registered = withRuntimeHomeEnv(() => loadRegistry().providers.filter(provider => provider.enabled));
  if (!claude && registered.length === 0 && !force) {
    return { runLive: false, skipReason: 'Claude CLI missing and no providers registered', cases: [] };
  }
  if (!claude) return gatedPlan(force, 'Claude CLI not found on PATH');
  if (!leverframe) return gatedPlan(force, 'leverframe CLI not found (install or build dist/cli.js)');
  if (registered.length === 0) return gatedPlan(force, 'no enabled providers in runtime config');
  const cases = await withRuntimeHomeEnvAsync(() => discoverSmokeCases());
  const routed = cases.filter(item => item.providerId !== 'anthropic-passthrough');
  if (routed.length === 0) return gatedPlan(force, 'no registered providers have credentials');
  return { runLive: true, cases };
}

/**
 * The smoke run patches whatever binary it resolves. Isolating LEVERFRAME_HOME
 * alone is not enough: state would land in the throwaway home while the real
 * installation keeps the injected bytes, leaving it injected with no
 * recoverable V2 state. Patch a disposable copy instead.
 */
function stageDisposableClaudeBinary(home: string): string | null {
  const installation = resolveClaudeInstallation({});
  if (!installation || installation.executableType !== 'binary') return null;
  // Stage pristine bytes. Copying an already-patched live binary would hand the
  // smoke run an injected target with no matching state in its throwaway home.
  const manifest = readManifestV2(installation.identity);
  const source = manifest?.baselinePath && existsSync(manifest.baselinePath)
    ? manifest.baselinePath
    : installation.canonicalPath;
  const staged = join(home, 'claude-under-test');
  copyFileSync(source, staged);
  chmodSync(staged, 0o755);
  return staged;
}

function writeSmokeHome(cases: SmokeCase[]): string {
  return withRuntimeHomeEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-live-smoke-'));
    const providersPath = getProvidersPath();
    if (existsSync(providersPath)) copyFileSync(providersPath, join(home, 'providers.json'));
    const fallbackSrc = getCredentialFallbackPath();
    if (existsSync(fallbackSrc)) copyFileSync(fallbackSrc, join(home, 'credentials-fallback.json'));
    const favorites: FavoriteModel[] = cases
      .filter(item => !item.passthrough)
      .map(item => ({ providerId: item.providerId, modelId: item.modelId }));
    writeFileSync(
      join(home, 'config.json'),
      `${JSON.stringify({ favoriteModels: favorites, claudeBridgeMode: 'proxy' }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return home;
  });
}

function kindLabel(kind: SmokeKind): string {
  if (kind === 'fail-timeout') return 'timeout';
  if (kind === 'fail-crash') return 'crash';
  if (kind === 'fail-leverframe') return 'Leverframe error';
  return 'Claude error';
}

function formatFailure(smokeCase: SmokeCase, result: SpawnSmokeResult, kind: SmokeKind): string {
  const spawnLine = result.spawnError
    ? `\n  spawnError: ${redactSmokeOutput(result.spawnError)}`
    : '';
  return [
    `Live Claude Code smoke failed (${kindLabel(kind)}) [--bare --tools "" --print]`,
    `  provider: ${smokeCase.providerId} (${smokeCase.providerName})`,
    `  model: ${smokeCase.modelId}`,
    `  modelRef: ${smokeCase.modelRef}`,
    `  exitCode: ${result.exitCode === null ? 'null' : String(result.exitCode)}`,
    `  signal: ${result.signal ?? 'none'}`,
    `  timedOut: ${result.timedOut}`,
    spawnLine,
    `  snippet: ${redactedSnippet(result.stdout, result.stderr)}`,
  ].join('\n');
}

function runLeverframeClaudePrint(modelRef: string, smokeHome: string): Promise<SpawnSmokeResult> {
  const cli = resolveLeverframeCli();
  if (!cli) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: 'leverframe CLI disappeared before spawn',
      stdout: '',
      stderr: '',
    });
  }
  const args = [
    ...cli.prefixArgs,
    'claude',
    '--proxy',
    '--',
    '--bare',
    '--tools',
    '',
    '--print',
    PROMPT,
    '--model',
    modelRef,
  ];
  return new Promise(resolve => {
    const child = spawn(cli.file, args, {
      cwd: smokeHome,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: `${LOCAL_BIN}${delimiter}${process.env['PATH'] ?? ''}`,
        LEVERFRAME_HOME: smokeHome,
        ...(stagedClaudeBinary ? { LEVERFRAME_CLAUDE_PATH: stagedClaudeBinary } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    let timedOut = false;
    let settled = false;
    const finish = (result: SpawnSmokeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(result);
    };
    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const killer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5_000).unref();
    }, LIVE_TIMEOUT_MS);
    child.on('error', err => {
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
        stdout,
        stderr,
      });
    });
    child.on('close', (exitCode, signal) => {
      finish({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

function sampleModel(id: string, extra: Partial<LocalProviderModel> = {}): LocalProviderModel {
  return {
    id,
    name: id,
    family: id,
    brand: 'test',
    modelFormat: 'openai',
    upstreamModelId: id,
    npm: '@ai-sdk/openai',
    ...extra,
  };
}

const livePlan = await buildLivePlan();

describe('live provider Claude smoke helpers', () => {
  it('prefers the known cheap catalog id when present', () => {
    const picked = pickCheapestModel('openai-oauth', [
      sampleModel('gpt-5.6-sol', { cost: { input: 1, output: 1 } }),
      sampleModel('gpt-5.6-luna', { cost: { input: 5, output: 5 } }),
    ]);
    expect(picked?.id).toBe('gpt-5.6-luna');
  });

  it('falls back to free then lowest listed cost', () => {
    const picked = pickCheapestModel('moonshot', [
      sampleModel('kimi-k2.6', { cost: { input: 3, output: 3 } }),
      sampleModel('kimi-k3', { isFree: true }),
    ]);
    expect(picked?.id).toBe('kimi-k3');
  });

  it('redacts bearer tokens from failure snippets', () => {
    const snippet = redactSmokeOutput('Authorization: Bearer sk-ant-secret123\nOK');
    expect(snippet).not.toMatch(/sk-ant-secret123/);
    expect(snippet).toMatch(/\[redacted\]/);
  });

  it('treats quota and limit text as a routing pass', () => {
    expect(isRoutingQuotaPass('You have hit your weekly limit')).toBe(true);
    expect(isRoutingQuotaPass('monthly usage limit reached')).toBe(true);
    expect(classifySmokeResult({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '429 Too Many Requests',
      stderr: '',
    }, 'leverframe:opencode-go:hy3')).toBe('pass-quota');
  });

  it('labels Leverframe proxy errors even when the process also timed out', () => {
    expect(classifySmokeResult({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      stdout: '',
      stderr: 'Failed to start proxy: EADDRINUSE',
    }, 'leverframe:openai-oauth:gpt-5.6-luna')).toBe('fail-leverframe');
  });

  it('treats OAuth failure on a leverframe model ref as a Leverframe fault', () => {
    expect(classifySmokeResult({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'OAuth refresh failed: invalid_grant',
    }, 'leverframe:openai-oauth:gpt-5.6-luna')).toBe('fail-leverframe');
  });

  it('does not treat a listed openai-oauth model id as an OAuth fault', () => {
    expect(classifySmokeResult({
      exitCode: 1,
      signal: null,
      timedOut: true,
      stdout: 'leverframe:openai-oauth:gpt-5.6-luna GPT-5.6 Luna (OpenAI (ChatGPT))',
      stderr: '',
    }, 'leverframe:opencode-go:hy3')).toBe('fail-timeout');
  });

  it('labels a missing V2 patch state as a Leverframe fault even after timeout', () => {
    expect(classifySmokeResult({
      exitCode: 143,
      signal: null,
      timedOut: true,
      stdout: '',
      stderr: 'Execution error leverframe: injected claude has no V2 patch state and cannot be recovered safely (No legacy manifest found.)',
    }, 'claude-haiku-4-5-20251001')).toBe('fail-leverframe');
  });
});

describe.skipIf(!livePlan.runLive && !livePlan.forceFailReason).sequential(
  'live Claude Code provider smoke',
  () => {
    let smokeHome: string | undefined;

    beforeAll(() => {
      if (!livePlan.runLive) return;
      smokeHome = writeSmokeHome(livePlan.cases);
      stagedClaudeBinary = stageDisposableClaudeBinary(smokeHome);
    });

    afterAll(() => {
      stagedClaudeBinary = null;
      if (smokeHome) rmSync(smokeHome, { recursive: true, force: true });
    });

    if (livePlan.forceFailReason) {
      it('requires Claude CLI, leverframe CLI, and a configured provider', () => {
        expect.fail(livePlan.forceFailReason ?? 'live smoke prerequisites missing');
      });
    } else {
      it.each(livePlan.cases)(
        '$providerId cheapest model $modelId',
        async (smokeCase) => {
          if (!smokeHome) {
            expect.fail('temp LEVERFRAME_HOME was not created for live smoke');
            return;
          }
          const result = await runLeverframeClaudePrint(smokeCase.modelRef, smokeHome);
          const kind = classifySmokeResult(result, smokeCase.modelRef);
          if (kind !== 'pass-ok' && kind !== 'pass-quota') {
            expect.fail(formatFailure(smokeCase, result, kind));
          }
          expect(kind.startsWith('pass')).toBe(true);
        },
        VITEST_TIMEOUT_MS,
      );
    }
  },
);
