// tests/patch-legacy-recovery.test.ts — regression coverage for recovering an
// injected pre-V2 Claude target whose live hash no longer matches the legacy
// manifest. Every case uses fixture files and a sandboxed LEVERFRAME_HOME;
// nothing resolves or modifies a real Claude installation.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import {
  inspectLegacyPatchRecovery,
  migrateLegacyStateIfVerified,
  type LegacyPatchRecoveryInspection,
} from '../src/patch-legacy-recovery.js';
import { addLeverframeInjectionMarker, classifyLeverframeInjectionByHash } from '../src/patch-injection.js';
import { diagnosePatchV2, formatPatchDiagnosticsText } from '../src/patch-diagnostics.js';
import { readManifestV2 } from '../src/patch-state.js';
import {
  checkResolvedPatchState,
  runLaunchPatchCheckV2,
  runPatchCommandV2,
} from '../src/patch-reconcile.js';
import type { PatchPresenter } from '../src/patch-presenter.js';
import {
  applyPatchTransactionV2,
  verifyPatchSites,
  type PatchRuntime,
} from '../src/patch-transaction.js';
import { applyLeverframePatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import type { PatchManifest as LegacyPatchManifest } from '../src/patcher.js';

const VERSION = '2.1.220';
const CURRENT_CONFIG: PatchScriptModelConfig = {
  'leverframe:openai:model': {
    alias: 'current',
    context: 272_000,
    display: 'Model (OpenAI)',
  },
};
const LEGACY_CONFIG: PatchScriptModelConfig = {
  'leverframe:openai:model': { alias: 'legacy', context: 200_000 },
};
const BASELINE = [
  '#!/bin/sh',
  'echo "2.1.220 (Claude Code)"',
  'exit 0',
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Fixture runtime that mirrors tweakcc inspection and patching using UTF-8 files. */
function fakeRuntime(options: { failPatch?: boolean; patchCalls?: string[] } = {}): PatchRuntime {
  return {
    async inspect(path, knownPatchedSha256) {
      try {
        const content = readFileSync(path, 'utf8');
        const hash = sha256(content);
        return {
          path,
          readable: true,
          version: VERSION,
          sha256: hash,
          injection: classifyLeverframeInjectionByHash(content, hash, knownPatchedSha256),
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
      options.patchCalls?.push(path);
      if (options.failPatch) throw new Error('synthetic patch failure');
      const patched = applyLeverframePatches(readFileSync(path, 'utf8'), config);
      writeFileSync(path, addLeverframeInjectionMarker(patched.content));
      return patched.results;
    },
    async readContent(path) {
      return readFileSync(path, 'utf8');
    },
  };
}

function installation(path: string): ClaudeInstallation {
  const canonicalPath = realpathSync(path);
  return {
    logicalPath: path,
    canonicalPath,
    installationPath: canonicalPath,
    discoverySource: 'explicit-target',
    installationKind: 'custom',
    identity: sha256(canonicalPath),
    version: VERSION,
    executableType: 'binary',
  };
}

function legacyManifest(input: {
  binaryPath: string;
  backupPath: string;
  recordedPatchedContent: string;
  baselineContent?: string;
}): LegacyPatchManifest {
  return {
    binaryPath: input.binaryPath,
    claudeVersion: VERSION,
    configHash: 'legacy-config-hash',
    patchedSize: Buffer.byteLength(input.recordedPatchedContent),
    patchedSha256: sha256(input.recordedPatchedContent),
    backupPath: input.backupPath,
    baselineSha256: sha256(input.baselineContent ?? BASELINE),
    patchedAt: '2026-07-28T20:55:26.171Z',
  };
}

const roots: string[] = [];
const previousHome = process.env['LEVERFRAME_HOME'];

function fixture(name: string): {
  root: string;
  livePath: string;
  backupPath: string;
  installation: ClaudeInstallation;
  legacy: LegacyPatchManifest;
  liveContent: string;
} {
  const root = mkdtempSync(join(tmpdir(), `leverframe-${name}-`));
  roots.push(root);
  process.env['LEVERFRAME_HOME'] = join(root, 'state-home');
  const livePath = join(root, 'claude');
  const backupPath = join(root, 'claude.orig');
  const recordedPatched = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, LEGACY_CONFIG).content);
  const liveContent = `${recordedPatched}\n// independently re-signed or rewritten after the legacy manifest`;
  writeFileSync(livePath, liveContent, { mode: 0o755 });
  writeFileSync(backupPath, BASELINE, { mode: 0o600 });
  const resolvedInstallation = installation(livePath);
  return {
    root,
    livePath,
    backupPath,
    installation: resolvedInstallation,
    legacy: legacyManifest({
      binaryPath: resolvedInstallation.canonicalPath,
      backupPath,
      recordedPatchedContent: recordedPatched,
    }),
    liveContent,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});

function expectRecoverable(
  inspection: LegacyPatchRecoveryInspection,
): asserts inspection is Extract<LegacyPatchRecoveryInspection, { kind: 'baseline-recovery' }> {
  expect(inspection.kind).toBe('baseline-recovery');
}

function expectUnavailable(
  inspection: LegacyPatchRecoveryInspection,
): asserts inspection is Extract<LegacyPatchRecoveryInspection, { kind: 'unavailable' }> {
  expect(inspection.kind).toBe('unavailable');
}

function seedCommandInputs(f: ReturnType<typeof fixture>): void {
  const home = process.env['LEVERFRAME_HOME']!;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    favoriteModels: [{ providerId: 'openai', modelId: 'model' }],
    modelAliases: [{ name: 'current', providerId: 'openai', modelId: 'model' }],
  }));
  writeFileSync(join(home, 'providers.json'), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: 'openai',
      templateId: 'openai',
      name: 'OpenAI',
      enabled: true,
      authRef: 'keyring:provider:openai',
      api: { npm: '@ai-sdk/openai' },
      modelsCache: {
        fetchedAt: '2026-07-29T00:00:00.000Z',
        models: [{
          id: 'model',
          name: 'Model',
          contextWindow: 272_000,
          modelFormat: 'anthropic',
        }],
      },
      addedAt: '2026-07-29T00:00:00.000Z',
    }],
  }));
  writeFileSync(join(home, 'patch-state.json'), JSON.stringify(f.legacy));
}

function recordingPresenter(): {
  presenter: PatchPresenter;
  errors: string[];
  successes: string[];
  confirmations: string[];
} {
  const errors: string[] = [];
  const successes: string[] = [];
  const confirmations: string[] = [];
  return {
    errors,
    successes,
    confirmations,
    presenter: {
      error: message => errors.push(message),
      warn: () => undefined,
      success: message => successes.push(message),
      detail: () => undefined,
      notice: () => undefined,
      confirm: async message => {
        confirmations.push(message);
        return true;
      },
    },
  };
}

/** Temporarily make launch checks interactive inside this isolated test worker. */
async function resignedPatchedFixture(name: string): Promise<{
  f: ReturnType<typeof fixture>;
  runtime: PatchRuntime;
  patchCalls: string[];
}> {
  const f = fixture(name);
  seedCommandInputs(f);
  writeFileSync(f.livePath, BASELINE, { mode: 0o755 });
  const patchCalls: string[] = [];
  const runtime = fakeRuntime({ patchCalls });
  const outcome = await applyPatchTransactionV2({
    installation: f.installation,
    desiredConfig: CURRENT_CONFIG,
    configHash: 'current-config-hash',
    manifest: null,
    trace: false,
  }, runtime);
  expect(outcome.ok).toBe(true);
  writeFileSync(f.livePath, `${readFileSync(f.livePath, 'utf8')}\n// deterministic post-publication rewrite`);
  expect((await checkResolvedPatchState(f.installation, runtime)).state).toBe('modified_but_injected');
  return { f, runtime, patchCalls };
}

/** Temporarily make launch checks interactive inside this isolated test worker. */
function setInteractiveTty(): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  return () => {
    if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  };
}

describe('legacy baseline recovery', () => {
  it('classifies an injected hash mismatch as recoverable when the legacy pristine backup verifies', async () => {
    const f = fixture('legacy-recovery-inspect');

    const inspection = await inspectLegacyPatchRecovery({ installation: f.installation, runtime: fakeRuntime(), legacy: f.legacy });

    expectRecoverable(inspection);
    expect(inspection.baseline).toMatchObject({
      sourcePath: f.backupPath,
      sha256: sha256(BASELINE),
      version: VERSION,
      provenance: 'legacy-migrated',
    });
    expect(readManifestV2(f.installation.identity)).toBeNull();
    expect(readFileSync(f.livePath, 'utf8')).toBe(f.liveContent);
  });

  it('reports verified baseline recovery honestly without mutating live or V2 state', async () => {
    const f = fixture('legacy-recovery-diagnose');
    seedCommandInputs(f);
    const before = readFileSync(f.livePath);

    const report = await diagnosePatchV2(f.livePath, fakeRuntime());

    expect(report.state).toBe('state_missing');
    expect(report.migration).toMatchObject({
      legacyManifestPresent: true,
      eligible: true,
      mode: 'baseline-recovery',
    });
    expect(report.drift.semanticSitesComplete).toBe(false);
    expect(report.nextAction).toMatch(/verified pristine legacy backup/i);
    const text = formatPatchDiagnosticsText(report).join('\n');
    expect(text).toMatch(/legacy migration\s+eligible — baseline-recovery/);
    expect(text).toMatch(/next action\s+Run `leverframe patch` to rebuild from the verified pristine legacy backup/);
    expect(readFileSync(f.livePath)).toEqual(before);
    expect(readManifestV2(f.installation.identity)).toBeNull();
  });
});

describe('legacy recovery launch flow', () => {
  it('recovers through the launch prompt once and does not prompt on the next launch', async () => {
    const f = fixture('legacy-recovery-command');
    seedCommandInputs(f);
    const runtime = fakeRuntime();
    const output = recordingPresenter();
    const restoreTty = setInteractiveTty();

    try {
      await runLaunchPatchCheckV2({ installation: f.installation, runtime }, output.presenter);
      const firstPatchedBytes = readFileSync(f.livePath);
      await runLaunchPatchCheckV2({ installation: f.installation, runtime }, output.presenter);

      expect(output.confirmations).toHaveLength(1);
      expect(output.confirmations[0]).toMatch(/verified pristine legacy backup/i);
      expect(output.errors).toEqual([]);
      expect(output.successes.some(message => message.includes('Patched claude'))).toBe(true);
      expect(readManifestV2(f.installation.identity)?.provenance).toBe('legacy-migrated');
      expect((await checkResolvedPatchState(f.installation, runtime)).state).toBe('patched');
      expect(readFileSync(f.livePath)).toEqual(firstPatchedBytes);
    } finally {
      restoreTty();
    }
  });
});

describe('legacy recovery transaction', () => {
  it('re-patches only from the verified pristine backup and publishes V2 state', async () => {
    const f = fixture('legacy-recovery-apply');
    const runtime = fakeRuntime();
    const inspection = await inspectLegacyPatchRecovery({ installation: f.installation, runtime, legacy: f.legacy });
    expectRecoverable(inspection);

    const outcome = await applyPatchTransactionV2({
      installation: f.installation,
      desiredConfig: CURRENT_CONFIG,
      configHash: 'current-config-hash',
      manifest: null,
      recoveryBaseline: inspection.baseline,
      trace: false,
    }, runtime);

    expect(outcome.ok).toBe(true);
    const manifest = readManifestV2(f.installation.identity);
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      generation: 1,
      baselineSha256: sha256(BASELINE),
      configHash: 'current-config-hash',
      provenance: 'legacy-migrated',
    });
    expect(existsSync(manifest!.baselinePath)).toBe(true);
    expect(readFileSync(manifest!.baselinePath, 'utf8')).toBe(BASELINE);
    expect(verifyPatchSites(readFileSync(f.livePath, 'utf8'), CURRENT_CONFIG).complete).toBe(true);
  });
});

describe('legacy recovery transaction safety', () => {
  it('revalidates the backup immediately before writing and rejects a verification race', async () => {
    const f = fixture('legacy-recovery-race');
    const runtime = fakeRuntime();
    const inspection = await inspectLegacyPatchRecovery({ installation: f.installation, runtime, legacy: f.legacy });
    expectRecoverable(inspection);
    writeFileSync(f.backupPath, `${BASELINE}\nchanged after inspection`);

    const outcome = await applyPatchTransactionV2({
      installation: f.installation,
      desiredConfig: CURRENT_CONFIG,
      configHash: 'current-config-hash',
      manifest: null,
      recoveryBaseline: inspection.baseline,
      trace: false,
    }, runtime);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/hash changed after verification/i);
    expect(readFileSync(f.livePath, 'utf8')).toBe(f.liveContent);
    expect(readManifestV2(f.installation.identity)).toBeNull();
  });

  it('preserves the injected live binary when re-patching the verified baseline fails', async () => {
    const f = fixture('legacy-recovery-failure');
    const inspection = await inspectLegacyPatchRecovery({ installation: f.installation, runtime: fakeRuntime(), legacy: f.legacy });
    expectRecoverable(inspection);

    const outcome = await applyPatchTransactionV2({
      installation: f.installation,
      desiredConfig: CURRENT_CONFIG,
      configHash: 'current-config-hash',
      manifest: null,
      recoveryBaseline: inspection.baseline,
      trace: false,
    }, fakeRuntime({ failPatch: true }));

    expect(outcome.ok).toBe(false);
    expect(readFileSync(f.livePath, 'utf8')).toBe(f.liveContent);
    expect(readManifestV2(f.installation.identity)).toBeNull();
  });
});

describe('legacy recovery refusal', () => {
  it('refuses recovery when the backup hash is corrupt, without touching the live binary', async () => {
    const f = fixture('legacy-recovery-corrupt');
    writeFileSync(f.backupPath, `${BASELINE}\ncorrupt`);

    const inspection = await inspectLegacyPatchRecovery({ installation: f.installation, runtime: fakeRuntime(), legacy: f.legacy });

    expectUnavailable(inspection);
    expect(inspection.reason).toMatch(/baseline hash/i);
    expect(readFileSync(f.livePath, 'utf8')).toBe(f.liveContent);
  });

  it('refuses recovery when the backup is itself injected', async () => {
    const f = fixture('legacy-recovery-injected-backup');
    const injectedBackup = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, LEGACY_CONFIG).content);
    writeFileSync(f.backupPath, injectedBackup);
    f.legacy.baselineSha256 = sha256(injectedBackup);

    const inspection = await inspectLegacyPatchRecovery({ installation: f.installation, runtime: fakeRuntime(), legacy: f.legacy });

    expectUnavailable(inspection);
    expect(inspection.reason).toMatch(/injection/i);
    expect(readFileSync(f.livePath, 'utf8')).toBe(f.liveContent);
  });
});

describe('semantically complete post-publication drift', () => {
  it('does not re-patch when exact bytes drift but all current sites remain complete', async () => {
    const { f, runtime, patchCalls } = await resignedPatchedFixture('resigned-direct');
    const output = recordingPresenter();

    const exitCode = await runPatchCommandV2({ installation: f.installation, runtime }, output.presenter);

    expect(exitCode).toBe(0);
    expect(patchCalls).toHaveLength(1);
    expect(output.successes.some(message => message.includes('already patched'))).toBe(true);
  });

  it('does not prompt during launch when exact bytes drift but all current sites remain complete', async () => {
    const { f, runtime, patchCalls } = await resignedPatchedFixture('resigned-launch');
    const output = recordingPresenter();
    const restoreTty = setInteractiveTty();

    try {
      await runLaunchPatchCheckV2({ installation: f.installation, runtime }, output.presenter);
      expect(output.confirmations).toEqual([]);
      expect(patchCalls).toHaveLength(1);
    } finally {
      restoreTty();
    }
  });
});

describe('exact legacy adoption', () => {
  it('marks an exact legacy adoption stale when current transforms would still change it', async () => {
    const f = fixture('legacy-exact-stale');
    const exactLegacyPatch = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, LEGACY_CONFIG).content);
    writeFileSync(f.livePath, exactLegacyPatch);
    f.legacy = legacyManifest({
      binaryPath: f.installation.canonicalPath,
      backupPath: f.backupPath,
      recordedPatchedContent: exactLegacyPatch,
    });
    seedCommandInputs(f);

    const checked = await checkResolvedPatchState(f.installation, fakeRuntime());

    expect(checked.state).toBe('config_stale');
    expect(checked.manifest?.transformVersion).toBe(0);
    expect(checked.manifest?.provenance).toBe('legacy-migrated');
  });

  it('keeps exact-hash adoption separate from baseline recovery', async () => {
    const f = fixture('legacy-exact-adoption');
    const exactPatched = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CURRENT_CONFIG).content);
    writeFileSync(f.livePath, exactPatched);
    const legacy = legacyManifest({
      binaryPath: f.installation.canonicalPath,
      backupPath: f.backupPath,
      recordedPatchedContent: exactPatched,
    });

    const inspection = await inspectLegacyPatchRecovery({
      installation: f.installation,
      runtime: fakeRuntime(),
      legacy,
    });
    expect(inspection.kind).toBe('exact-adoption');

    const migrated = await migrateLegacyStateIfVerified({
      installation: f.installation,
      runtime: fakeRuntime(),
      legacy,
    });
    expect(migrated.migrated).toBe(true);
    expect(readManifestV2(f.installation.identity)?.provenance).toBe('legacy-migrated');
  });
});
