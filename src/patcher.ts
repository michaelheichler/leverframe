import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { getAppHome } from './paths.js';
import { loadPreferences } from './config.js';
import { loadRegistry } from './registry/io.js';
import { buildClaudeVersionProbe, findClaudeBinary } from './launch.js';
import { httpProxyDisplayName, httpProxyModelId } from './http-proxy/routes.js';
import { stripOneMContextSuffix } from './context-model-id.js';
import {
  applyLeverframePatches,
  formatPatchSiteLine,
  PatchApplyError,
  type PatchSiteResult,
  type PatchScriptModelConfig,
} from './patch-transforms.js';


export interface PatchManifest {
  binaryPath: string;
  claudeVersion: string;
  configHash: string;
  patchedSize: number;
  patchedSha256: string;
  backupPath: string;
  baselineSha256?: string;
  patchedAt: string;
}

export const LEVERFRAME_INJECTION_MARKER = '/*leverframe:patch:v1*/';

export function getPatchManifestPath(): string {
  return join(getAppHome(), 'patch-state.json');
}

export function getPatchLockPath(): string {
  return join(getAppHome(), 'patch.lock');
}

export function readPatchManifest(path = getPatchManifestPath()): PatchManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PatchManifest;
    if (parsed && typeof parsed.binaryPath === 'string' && typeof parsed.configHash === 'string') {
      return parsed;
    }
  } catch {
  }
  return null;
}

function writePatchManifest(manifest: PatchManifest, path = getPatchManifestPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staged = join(dirname(path), `.leverframe-${basename(path)}-${randomUUID()}`);
  try {
    writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(staged, path);
  } finally {
    try {
      unlinkSync(staged);
    } catch {
    }
  }
}


export interface DesiredPatchConfig {
  config: PatchScriptModelConfig;
  unknownWindows: string[];
}

export interface PatchModelMeta {
  contextWindow?: number;
  displayName?: string;
}

export function buildPatchModelConfig(
  favorites: Array<{ providerId: string; modelId: string }>,
  aliases: Array<{ name: string; providerId: string; modelId: string }>,
  modelMetaFor: (providerId: string, modelId: string) => PatchModelMeta | undefined,
): DesiredPatchConfig {
  const config: PatchScriptModelConfig = {};
  const unknownWindows: string[] = [];
  const aliasByFavorite = new Map(aliases.map(a => [`${a.providerId}:${a.modelId}`, a.name]));

  for (const favorite of favorites) {
    const id = stripOneMContextSuffix(httpProxyModelId(favorite.providerId, favorite.modelId));
    if (config[id]) continue;
    const meta = modelMetaFor(favorite.providerId, favorite.modelId);
    const context = meta?.contextWindow;
    const alias = aliasByFavorite.get(`${favorite.providerId}:${favorite.modelId}`);
    const entry: PatchScriptModelConfig[string] = {};
    if (alias) entry.alias = alias;
    if (context === undefined || context <= 0) unknownWindows.push(id);
    else if (context !== 200_000) entry.context = context;
    const display = meta?.displayName?.trim();
    if (display) entry.display = display;
    config[id] = entry;
  }
  return { config, unknownWindows };
}

export function computePatchConfigHash(config: PatchScriptModelConfig): string {
  const canonical = Object.keys(config).sort().map(key => {
    const entry = config[key]!;
    return [key, entry.alias ?? null, entry.context ?? null, entry.display ?? null];
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildDesiredPatchConfig(): DesiredPatchConfig {
  const prefs = loadPreferences();
  const favorites = prefs.favoriteModels ?? [];
  const aliases = prefs.modelAliases ?? [];
  const registry = loadRegistry();

  const meta = new Map<string, PatchModelMeta>();
  for (const provider of registry.providers) {
    for (const model of provider.modelsCache?.models ?? []) {
      meta.set(`${provider.id}:${model.id}`, {
        contextWindow: model.contextWindow && model.contextWindow > 0 ? model.contextWindow : undefined,
        displayName: httpProxyDisplayName(model, provider.name),
      });
    }
  }

  return buildPatchModelConfig(
    favorites,
    aliases,
    (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
  );
}


export type PatchState = 'unpatched' | 'current' | 'stale-config' | 'stale-binary';

export function evaluatePatchState(
  manifest: PatchManifest | null,
  current: {
    binaryPath: string;
    claudeVersion: string;
    configHash: string;
    binarySize?: number;
    binarySha256?: string;
  },
): PatchState {
  if (!manifest) return 'unpatched';
  if (manifest.binaryPath !== current.binaryPath) return 'unpatched';
  if (manifest.claudeVersion !== current.claudeVersion) return 'stale-binary';
  if (current.binarySize !== undefined && manifest.patchedSize !== current.binarySize) return 'stale-binary';
  if (current.binarySha256 !== undefined && manifest.patchedSha256 !== current.binarySha256) return 'stale-binary';
  if (manifest.configHash !== current.configHash) return 'stale-config';
  return 'current';
}


const PATCH_LOCK_STALE_MS = 10 * 60 * 1000;

interface PatchLockContent {
  pid: number;
  startedAt: number;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function tryAcquirePatchLock(
  lockPath = getPatchLockPath(),
  opts: { now?: number; isAlive?: (pid: number) => boolean } = {},
): (() => void) | null {
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? pidIsAlive;
  mkdirSync(join(lockPath, '..'), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      const content: PatchLockContent = { pid: process.pid, startedAt: now };
      writeFileSync(fd, JSON.stringify(content));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
        }
      };
    } catch {
      let stale = false;
      try {
        const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as PatchLockContent;
        stale = !existing.pid
          || !isAlive(existing.pid)
          || (typeof existing.startedAt === 'number' && now - existing.startedAt > PATCH_LOCK_STALE_MS);
      } catch {
        stale = true;
      }
      if (!stale) return null;
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
  }
  return null;
}


function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export type InjectionState = 'present' | 'absent' | 'ambiguous';

export interface InjectionClassification {
  state: InjectionState;
  evidence: 'marker-v1' | 'manifest-hash' | 'ccpatch' | 'none' | 'unknown-marker';
}

function classifyVersionedMarker(content: string): InjectionClassification {
  const markers = content.match(/\/\*leverframe:patch:[^*]*\*\//g) ?? [];
  const markerPrefixes = content.split('/*leverframe:patch:').length - 1;
  if (markerPrefixes !== markers.length) {
    return { state: 'ambiguous', evidence: 'unknown-marker' };
  }
  if (markers.length === 0) {
    return { state: 'absent', evidence: 'none' };
  }
  return markers.length === 1 && markers[0] === LEVERFRAME_INJECTION_MARKER
    ? { state: 'present', evidence: 'marker-v1' }
    : { state: 'ambiguous', evidence: 'unknown-marker' };
}

export function classifyLeverframeInjection(
  content: string,
  sha256: string,
  manifest: PatchManifest | null,
  binaryPath: string,
): InjectionClassification {
  const marker = classifyVersionedMarker(content);
  if (marker.state !== 'absent') return marker;
  if (content.includes('/*ccpatch:ctx*/')) return { state: 'present', evidence: 'ccpatch' };
  if (
    manifest?.binaryPath === binaryPath
    && manifest.patchedSha256.length > 0
    && manifest.patchedSha256 === sha256
  ) {
    return { state: 'present', evidence: 'manifest-hash' };
  }
  return marker;
}

export function addLeverframeInjectionMarker(content: string): string {
  const marker = classifyVersionedMarker(content);
  if (marker.state === 'ambiguous') {
    throw new Error('leverframe patch: unrecognized injection marker');
  }
  return marker.state === 'present' ? content : `${content}\n${LEVERFRAME_INJECTION_MARKER}`;
}

export interface PatchBinaryInspection {
  path: string;
  readable: boolean;
  version: string | null;
  sha256: string | null;
  injection: InjectionClassification;
}

export interface PatchBinaryRuntime {
  inspect(path: string, manifest?: PatchManifest | null): Promise<PatchBinaryInspection>;
  patch(path: string, config: PatchScriptModelConfig): Promise<PatchSiteResult[]>;
}

type PatchOperation = 'patch' | 'restore';

type BaselineChoice =
  | { ok: true; source: 'live' | 'backup' }
  | { ok: false; reason: string };

export function choosePatchBaseline(
  operation: PatchOperation,
  live: PatchBinaryInspection,
  backup: PatchBinaryInspection | null,
  manifest: PatchManifest | null,
  expected: { binaryPath: string; backupPath: string; version: string },
): BaselineChoice {
  if (!live.readable || !live.sha256 || !live.version) {
    return { ok: false, reason: 'Cannot inspect the live claude binary.' };
  }
  if (live.version !== expected.version) {
    return { ok: false, reason: 'The live claude version changed during inspection.' };
  }
  if (live.injection.state === 'ambiguous') {
    return { ok: false, reason: 'The live claude injection marker is ambiguous.' };
  }
  if (live.injection.state === 'absent') {
    return operation === 'patch'
      ? { ok: true, source: 'live' }
      : { ok: false, reason: 'Refusing restore because the live claude binary is not Leverframe-injected.' };
  }
  if (!manifest) return { ok: false, reason: 'Injected claude has no patch manifest.' };
  if (manifest.binaryPath !== expected.binaryPath || manifest.backupPath !== expected.backupPath) {
    return { ok: false, reason: 'The patch manifest paths do not match the live binary and baseline.' };
  }
  if (
    manifest.claudeVersion !== expected.version
    || !backup?.version
    || backup.version !== expected.version
  ) {
    return { ok: false, reason: 'The live, baseline, and manifest claude versions do not match.' };
  }
  if (!backup.readable || !backup.sha256) {
    return { ok: false, reason: 'The saved baseline is missing or unreadable.' };
  }
  if (backup.injection.state !== 'absent' || manifest.patchedSha256 === backup.sha256) {
    return { ok: false, reason: 'The saved baseline is injected or has an ambiguous marker.' };
  }
  if (!manifest.baselineSha256 || manifest.baselineSha256 !== backup.sha256) {
    return { ok: false, reason: 'The saved baseline hash does not match the patch manifest.' };
  }
  return { ok: true, source: 'backup' };
}

function readExactClaudeVersion(path: string): string | null {
  try {
    const probe = buildClaudeVersionProbe(path);
    if (!probe) return null;
    const output = execFileSync(probe.file, probe.args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    return output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function resolveClaudeBinaryForPatch(): { binaryPath: string; version: string } | null {
  const envOverride = process.env['TWEAKCC_CC_INSTALLATION_PATH'];
  const nativeSymlink = join(homedir(), '.local', 'bin', 'claude');
  const source = envOverride?.trim()
    || (existsSync(nativeSymlink) ? nativeSymlink : null)
    || findClaudeBinary();
  if (!source) return null;
  let resolved: string;
  try {
    resolved = realpathSync(source);
  } catch {
    return null;
  }
  try {
    if (!statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  const version = readExactClaudeVersion(resolved);
  return version ? { binaryPath: resolved, version } : null;
}

export function getPristineBackupPath(version: string, binaryPath: string): string {
  const tag = version.replace(/[^\w.-]+/g, '_') || basename(binaryPath);
  return join(getAppHome(), 'backups', `claude-${tag}.orig`);
}

function stagingPath(destination: string): string {
  return join(dirname(dirname(destination)), `.leverframe-${basename(destination)}-${randomUUID()}`);
}

function removeFileIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
  }
}

export function summarizePatchResults(results: PatchSiteResult[]): string[] {
  const lines = results.map(formatPatchSiteLine);
  const ok = results.filter(r => r.status === 'OK').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const failed = results.filter(r => r.status === 'FAIL');
  lines.push(`leverframe patch: ${ok} applied, ${skip} skipped, ${failed.length} failed`);
  if (failed.length) {
    lines.push(`leverframe patch: FAILED patches: ${failed.map(f => f.name).join('; ')}`);
  }
  return lines;
}


export interface ApplyOutcome {
  ok: boolean;
  message: string;
  detailLines?: string[];
}

const patchBinaryRuntime: PatchBinaryRuntime = {
  async inspect(path, manifest = null) {
    try {
      if (!statSync(path).isFile()) throw new Error('not a file');
      const sha256 = sha256File(path);
      const { tryDetectInstallation, readContent } = await import('tweakcc');
      const installation = await tryDetectInstallation({ path });
      const version = installation.version;
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('embedded version unavailable');
      const content = await readContent(installation);
      return {
        path,
        readable: true,
        version,
        sha256,
        injection: classifyLeverframeInjection(content, sha256, manifest, path),
      };
    } catch {
      return {
        path,
        readable: false,
        version: null,
        sha256: null,
        injection: { state: 'ambiguous', evidence: 'unknown-marker' },
      };
    }
  },
  async patch(path, config) {
    const { tryDetectInstallation, readContent, writeContent } = await import('tweakcc');
    const installation = await tryDetectInstallation({ path });
    const source = await readContent(installation);
    const patched = applyLeverframePatches(source, config);
    await writeContent(installation, addLeverframeInjectionMarker(patched.content));
    return patched.results;
  },
};

export interface PatchTransactionInput {
  binaryPath: string;
  backupPath: string;
  manifestPath: string;
  version: string;
  desired: DesiredPatchConfig;
  configHash: string;
  manifest: PatchManifest | null;
  trace: boolean;
}

export async function applyPatchTransaction(
  input: PatchTransactionInput,
  runtime: PatchBinaryRuntime = patchBinaryRuntime,
): Promise<ApplyOutcome> {
  const {
    binaryPath,
    backupPath,
    manifestPath,
    version,
    desired,
    configHash,
    manifest,
    trace,
  } = input;
  mkdirSync(dirname(backupPath), { recursive: true });
  const baselineStage = stagingPath(backupPath);
  const patchedStage = stagingPath(binaryPath);
  let results: PatchSiteResult[] = [];
  try {
    const live = await runtime.inspect(binaryPath, manifest);
    const backup = live.injection.state === 'present' && existsSync(backupPath)
      ? await runtime.inspect(backupPath)
      : null;
    const choice = choosePatchBaseline('patch', live, backup, manifest, {
      binaryPath,
      backupPath,
      version,
    });
    if (!choice.ok) return { ok: false, message: choice.reason };

    const baseline = choice.source === 'live' ? live : backup!;
    copyFileSync(baseline.path, baselineStage);
    const stagedBaseline = await runtime.inspect(baselineStage);
    if (
      !stagedBaseline.readable
      || stagedBaseline.version !== version
      || stagedBaseline.injection.state !== 'absent'
      || stagedBaseline.sha256 !== baseline.sha256
    ) {
      return { ok: false, message: 'Candidate baseline failed staged validation.' };
    }

    copyFileSync(baselineStage, patchedStage);
    results = await runtime.patch(patchedStage, desired.config);
    const stagedPatched = await runtime.inspect(patchedStage);
    if (
      !stagedPatched.readable
      || stagedPatched.version !== version
      || stagedPatched.injection.evidence !== 'marker-v1'
      || !stagedPatched.sha256
    ) {
      return { ok: false, message: 'Patched candidate failed staged validation.' };
    }

    renameSync(baselineStage, backupPath);
    renameSync(patchedStage, binaryPath);
    writePatchManifest({
      binaryPath,
      claudeVersion: version,
      configHash,
      patchedSize: statSync(binaryPath).size,
      patchedSha256: stagedPatched.sha256,
      backupPath,
      baselineSha256: stagedBaseline.sha256!,
      patchedAt: new Date().toISOString(),
    }, manifestPath);
  } catch (err) {
    const detailLines = err instanceof PatchApplyError ? summarizePatchResults(err.results) : [];
    if (trace && detailLines.length) {
      process.stderr.write(`${detailLines.join('\n')}\n`);
    }
    return {
      ok: false,
      message: `Patch failed: ${err instanceof Error ? err.message : String(err)}`,
      detailLines,
    };
  } finally {
    removeFileIfExists(baselineStage);
    removeFileIfExists(patchedStage);
  }

  if (trace) {
    process.stderr.write(`${summarizePatchResults(results).join('\n')}\n`);
  }
  const modelCount = Object.keys(desired.config).length;
  const aliasCount = Object.values(desired.config).filter(entry => entry.alias).length;
  const windowCount = Object.values(desired.config).filter(entry => entry.context).length;
  return {
    ok: true,
    message: `Patched claude ${version}: ${modelCount} model${modelCount === 1 ? '' : 's'}, `
      + `${aliasCount} alias${aliasCount === 1 ? '' : 'es'}, ${windowCount} context window${windowCount === 1 ? '' : 's'}.`,
    detailLines: summarizePatchResults(results),
  };
}

export interface RestoreTransactionInput {
  binaryPath: string;
  backupPath: string;
  manifestPath: string;
  version: string;
  manifest: PatchManifest | null;
}

export async function restorePatchTransaction(
  input: RestoreTransactionInput,
  runtime: PatchBinaryRuntime = patchBinaryRuntime,
): Promise<ApplyOutcome> {
  const { binaryPath, backupPath, manifestPath, version, manifest } = input;
  const staged = stagingPath(binaryPath);
  try {
    const live = await runtime.inspect(binaryPath, manifest);
    const backup = live.injection.state === 'present' && existsSync(backupPath)
      ? await runtime.inspect(backupPath)
      : null;
    const choice = choosePatchBaseline('restore', live, backup, manifest, {
      binaryPath,
      backupPath,
      version,
    });
    if (!choice.ok) return { ok: false, message: choice.reason };

    copyFileSync(backupPath, staged);
    const candidate = await runtime.inspect(staged);
    if (
      !candidate.readable
      || candidate.version !== version
      || candidate.injection.state !== 'absent'
      || candidate.sha256 !== backup!.sha256
    ) {
      return { ok: false, message: 'Restore candidate failed staged validation.' };
    }
    renameSync(staged, binaryPath);
    try {
      unlinkSync(manifestPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return { ok: true, message: `Restored pristine claude ${version} from ${backupPath}.` };
  } catch (err) {
    return {
      ok: false,
      message: `Restore failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    removeFileIfExists(staged);
  }
}

export async function runPatchCommand(opts: { restore?: boolean; trace?: boolean } = {}): Promise<number> {
  const resolved = resolveClaudeBinaryForPatch();
  if (!resolved) {
    p.log.error('claude binary not found. Install Claude Code or set TWEAKCC_CC_INSTALLATION_PATH.');
    return 1;
  }
  const { binaryPath, version } = resolved;
  const backupPath = getPristineBackupPath(version, binaryPath);
  const manifestPath = getPatchManifestPath();
  const manifest = readPatchManifest(manifestPath);

  if (opts.restore) {
    const release = tryAcquirePatchLock();
    if (!release) {
      p.log.warn('Another leverframe process is patching the claude binary right now. Skipped.');
      return 1;
    }
    try {
      const outcome = await restorePatchTransaction({
        binaryPath,
        backupPath,
        manifestPath,
        version,
        manifest,
      });
      if (!outcome.ok) {
        p.log.error(outcome.message);
        return 1;
      }
      p.log.success(outcome.message);
      return 0;
    } finally {
      release();
    }
  }

  const desired = buildDesiredPatchConfig();
  if (Object.keys(desired.config).length === 0) {
    p.log.error('No favorite models to patch. Save favorites with `leverframe models` first.');
    return 1;
  }
  for (const id of desired.unknownWindows) {
    p.log.warn(`No context window metadata for ${id}. Claude Code will assume the 200k default.`);
  }

  const configHash = computePatchConfigHash(desired.config);
  const state = evaluatePatchState(manifest, {
    binaryPath,
    claudeVersion: version,
    configHash,
    binarySize: statSync(binaryPath).size,
    binarySha256: sha256File(binaryPath),
  });

  if (state === 'current') {
    p.log.success(`claude ${version} is already patched with the current model config. Nothing to do.`);
    return 0;
  }

  const release = tryAcquirePatchLock();
  if (!release) {
    p.log.warn('Another leverframe process is patching the claude binary right now. Skipped.');
    return 1;
  }

  try {
    const outcome = await applyPatchTransaction({
      binaryPath,
      backupPath,
      manifestPath,
      version,
      desired,
      configHash,
      manifest,
      trace: opts.trace ?? false,
    });
    if (!outcome.ok) {
      p.log.error(outcome.message);
      for (const line of outcome.detailLines ?? []) p.log.info(pc.dim(line));
      return 1;
    }
    p.log.success(outcome.message);
    if (!opts.trace) {
      for (const line of outcome.detailLines ?? []) p.log.info(pc.dim(line));
    }
    return 0;
  } finally {
    release();
  }
}


export async function runLaunchPatchCheck(opts: { agentStdout?: boolean; dryRun?: boolean } = {}): Promise<void> {
  try {
    const desired = buildDesiredPatchConfig();
    if (Object.keys(desired.config).length === 0) return;

    const resolved = resolveClaudeBinaryForPatch();
    if (!resolved) return;

    const configHash = computePatchConfigHash(desired.config);
    const manifest = readPatchManifest();
    const state = evaluatePatchState(manifest, {
      binaryPath: resolved.binaryPath,
      claudeVersion: resolved.version,
      configHash,
      binarySize: statSync(resolved.binaryPath).size,
      binarySha256: sha256File(resolved.binaryPath),
    });
    if (state === 'current') return;

    const interactive = !opts.dryRun && !opts.agentStdout
      && process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) {
      if (!opts.agentStdout) {
        console.error(pc.dim(`leverframe: claude binary is ${state === 'unpatched' ? 'not patched' : 'stale-patched'} for your favorites. Run \`leverframe patch\`.`));
      }
      return;
    }

    const answer = await p.confirm({
      message: state === 'unpatched'
        ? 'Claude Code is not patched for your leverframe favorites. Patch now?'
        : 'The Claude Code patch is stale (config or claude version changed). Re-patch now?',
      initialValue: false,
    });
    if (p.isCancel(answer) || answer !== true) return;

    await runPatchCommand({});
  } catch (err) {
    console.error(pc.dim(`leverframe: patch check skipped (${err instanceof Error ? err.message : String(err)})`));
  }
}
