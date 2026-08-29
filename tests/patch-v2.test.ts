import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveClaudeInstallation, type ClaudeInstallation } from '../src/claude-installation.js';
import {
  currentTransformVersion,
  ensureBaselineStored,
  getBaselinePathV2,
  getPatchTargetDir,
  readManifestV2,
  type PatchManifestV2,
} from '../src/patch-state.js';
import { evaluatePatchStateV2 } from '../src/patch-classify.js';
import { getPatchTargetLockPath, tryAcquirePatchTargetLock } from '../src/patch-lock.js';
import {
  applyPatchTransactionV2,
  clearPatchJournal,
  getPatchJournalPath,
  readPatchJournal,
  restorePatchTransactionV2,
  verifyPatchSites,
  type PatchRuntime,
  type PatchTransactionJournal,
} from '../src/patch-transaction.js';
import {
  checkPatchState,
  reconcilePatchTransaction,
} from '../src/patch-reconcile.js';
import { migrateLegacyStateIfVerified } from '../src/patch-legacy-recovery.js';
import { addLeverframeInjectionMarker, classifyLeverframeInjectionByHash } from '../src/patch-injection.js';
import { applyLeverframePatches } from '../src/patch-transforms.js';
import type { PatchManifest as LegacyPatchManifest } from '../src/patcher.js';

const VERSION = '2.1.223';
const CONFIG = { 'leverframe:openai:model': { alias: 'model', context: 272_000 } };
const BASELINE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fakeRuntime(opts: { version?: string; failPatch?: boolean } = {}): PatchRuntime {
  const version = opts.version ?? VERSION;
  return {
    async inspect(path, knownPatchedSha256) {
      try {
        const content = readFileSync(path, 'utf8');
        const hash = sha256(content);
        return {
          path,
          readable: true,
          version,
          sha256: hash,
          injection: classifyLeverframeInjectionByHash(content, hash, knownPatchedSha256),
        };
      } catch {
        return { path, readable: false, version: null, sha256: null, injection: { state: 'ambiguous', evidence: 'unknown-marker' } };
      }
    },
    async patch(path, config) {
      if (opts.failPatch) throw new Error('synthetic patch failure');
      const patched = applyLeverframePatches(readFileSync(path, 'utf8'), config);
      writeFileSync(path, addLeverframeInjectionMarker(patched.content));
      return patched.results;
    },
    async readContent(path) {
      return readFileSync(path, 'utf8');
    },
  };
}

const dirs: string[] = [];
const homes: string[] = [];
let previousHome: string | undefined;

function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-patch-v2-home-'));
  homes.push(home);
  process.env['LEVERFRAME_HOME'] = home;
  return home;
}

beforeEach(() => {
  previousHome = process.env['LEVERFRAME_HOME'];
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});

function makeInstallation(canonicalPath: string, overrides: Partial<ClaudeInstallation> = {}): ClaudeInstallation {
  return {
    logicalPath: canonicalPath,
    canonicalPath,
    installationPath: canonicalPath,
    discoverySource: 'explicit-target',
    installationKind: 'custom',
    identity: createHash('sha256').update(canonicalPath).digest('hex'),
    version: VERSION,
    executableType: 'binary',
    ...overrides,
  };
}

describe('claude-installation identity', () => {
  it('is a stable SHA-256 of the canonical (symlink-resolved) path, shared regardless of which alias resolves it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-identity-'));
    dirs.push(dir);
    const real = join(dir, 'claude-real');
    writeFileSync(real, '#!/bin/sh\necho "2.1.220 (Claude Code)"\n', { mode: 0o755 });
    const link = join(dir, 'claude-link');
    symlinkSync(real, link);

    const canonicalReal = realpathSync(real);
    const viaReal = resolveClaudeInstallation({ target: real });
    const viaLink = resolveClaudeInstallation({ target: link });
    expect(viaReal?.canonicalPath).toBe(canonicalReal);
    expect(viaLink?.canonicalPath).toBe(canonicalReal);
    expect(viaReal?.identity).toBe(viaLink?.identity);
    expect(viaReal?.identity).toBe(createHash('sha256').update(canonicalReal).digest('hex'));
    expect(viaLink?.logicalPath).toBe(link);
    expect(viaLink?.discoverySource).toBe('explicit-target');
  });

  it('resolves two different installations to two different identities and state directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-two-installs-'));
    dirs.push(dir);
    const a = join(dir, 'a', 'claude');
    const b = join(dir, 'b', 'claude');
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeFileSync(a, '#!/bin/sh\necho "2.1.220 (Claude Code)"\n', { mode: 0o755 });
    writeFileSync(b, '#!/bin/sh\necho "2.1.220 (Claude Code)"\n', { mode: 0o755 });

    const resolvedA = resolveClaudeInstallation({ target: a });
    const resolvedB = resolveClaudeInstallation({ target: b });
    expect(resolvedA?.identity).not.toBe(resolvedB?.identity);
    expect(getPatchTargetDir(resolvedA!.identity)).not.toBe(getPatchTargetDir(resolvedB!.identity));
    expect(getPatchTargetLockPath(resolvedA!.identity)).not.toBe(getPatchTargetLockPath(resolvedB!.identity));
  });

  it('returns null for a target that does not resolve to a versioned executable', () => {
    expect(resolveClaudeInstallation({ target: join(tmpdir(), 'does-not-exist-claude') })).toBeNull();
  });
});

describe('content-addressed baseline storage', () => {
  it('is immutable and idempotent: storing the same content twice is a no-op that returns the same path', () => {
    const home = useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-baseline-'));
    dirs.push(dir);
    const source = join(dir, 'claude.orig');
    writeFileSync(source, BASELINE);
    const identity = 'target-identity';
    const hash = sha256(BASELINE);

    const first = ensureBaselineStored({ identity, version: VERSION, baselineSha256: hash, sourcePath: source });
    expect(first).toBe(getBaselinePathV2(identity, VERSION, hash));
    expect(readFileSync(first, 'utf8')).toBe(BASELINE);

    const again = ensureBaselineStored({ identity, version: VERSION, baselineSha256: hash, sourcePath: source });
    expect(again).toBe(first);
    expect(home).toBeTruthy();
  });
});

describe('applyPatchTransactionV2 / restorePatchTransactionV2', () => {
  it('patches, publishes a V2 manifest with the expected fields, and leaves no pending journal', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-apply-v2-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);

    const outcome = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'config-hash-1', manifest: null, trace: false },
      fakeRuntime(),
    );
    expect(outcome.ok).toBe(true);

    const manifest = readManifestV2(installation.identity);
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation: 1,
      canonicalPath,
      claudeVersion: VERSION,
      configHash: 'config-hash-1',
      provenance: 'live',
    });
    expect(manifest!.baselineSha256).toBe(sha256(BASELINE));
    expect(existsSync(manifest!.baselinePath)).toBe(true);
    expect(readFileSync(canonicalPath, 'utf8')).toContain('/*leverframe:patch:v1*/');
    expect(readPatchJournal(installation.identity)?.phase).toBe('completed');
  });

  it('is idempotent-safe: restore then re-patch round-trips back to the exact pristine baseline', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-roundtrip-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);
    const runtime = fakeRuntime();

    await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'hash-a', manifest: null, trace: false },
      runtime,
    );
    const patchedManifest = readManifestV2(installation.identity)!;

    const restored = await restorePatchTransactionV2({ installation, manifest: patchedManifest }, runtime);
    expect(restored.ok).toBe(true);
    expect(readFileSync(canonicalPath, 'utf8')).toBe(BASELINE);
    expect(readManifestV2(installation.identity)).toBeNull();
    expect(readPatchJournal(installation.identity)?.phase).toBe('completed');
  });

  it.skipIf(process.platform === 'win32')(
    'repairs a stored baseline that lost its executable bit before restore inspects it',
    async () => {
      useTempHome();
      const dir = mkdtempSync(join(tmpdir(), 'leverframe-restore-baseline-mode-'));
      dirs.push(dir);
      const canonicalPath = join(dir, 'claude');
      writeFileSync(canonicalPath, BASELINE);
      chmodSync(canonicalPath, 0o755);
      const installation = makeInstallation(canonicalPath);
      const inner = fakeRuntime();
      const executeRequired: PatchRuntime = {
        ...inner,
        async inspect(path, knownPatchedSha256) {
          if ((statSync(path).mode & 0o100) === 0) {
            return {
              path,
              readable: false,
              version: null,
              sha256: null,
              injection: { state: 'ambiguous', evidence: 'inspect-failed' },
              error: 'embedded version unavailable',
            };
          }
          return inner.inspect(path, knownPatchedSha256);
        },
      };

      await applyPatchTransactionV2(
        { installation, desiredConfig: CONFIG, configHash: 'hash-a', manifest: null, trace: false },
        inner,
      );
      const patchedManifest = readManifestV2(installation.identity)!;
      chmodSync(canonicalPath, 0o755);
      chmodSync(patchedManifest.baselinePath, 0o600);

      const restored = await restorePatchTransactionV2(
        { installation, manifest: patchedManifest },
        executeRequired,
      );
      expect(restored.ok).toBe(true);
      expect(readFileSync(canonicalPath, 'utf8')).toBe(BASELINE);
      expect(statSync(patchedManifest.baselinePath).mode & 0o777).toBe(0o700);
    },
  );

  it('refuses to patch when the target changed version mid-inspection, leaving the target untouched', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-version-race-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath, { version: '9.9.9' });

    const before = readFileSync(canonicalPath);
    const outcome = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'hash', manifest: null, trace: false },
      fakeRuntime({ version: VERSION }),
    );
    expect(outcome.ok).toBe(false);
    expect(readFileSync(canonicalPath)).toEqual(before);
  });

  it('preserves the live binary and writes no manifest when the underlying patch step fails', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-fail-patch-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);
    const before = readFileSync(canonicalPath);

    const outcome = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'hash', manifest: null, trace: false },
      fakeRuntime({ failPatch: true }),
    );
    expect(outcome.ok).toBe(false);
    expect(readFileSync(canonicalPath)).toEqual(before);
    expect(readManifestV2(installation.identity)).toBeNull();
  });
});

describe('restart reconciliation over every journal phase', () => {
  function baseJournal(installation: ClaudeInstallation, extra: Partial<PatchTransactionJournal>): PatchTransactionJournal {
    return {
      schemaVersion: 1,
      operation: 'patch',
      identity: installation.identity,
      canonicalPath: installation.canonicalPath,
      generation: 1,
      phase: 'prepared',
      expectedPreHash: sha256(BASELINE),
      claudeVersion: VERSION,
      baselineSha256: '',
      baselinePath: '',
      configHash: 'hash',
      transformVersion: currentTransformVersion(),
      provenance: 'live',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    };
  }

  function writeJournalFixture(journal: PatchTransactionJournal): void {
    mkdirSync(getPatchTargetDir(journal.identity), { recursive: true, mode: 0o700 });
    writeFileSync(getPatchJournalPath(journal.identity), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  }

  it('discards a journal stuck at `prepared` when no destructive work occurred', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-reconcile-prepared-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);
    writeJournalFixture(baseJournal(installation, { phase: 'prepared' }));

    const result = await reconcilePatchTransaction(installation, fakeRuntime());
    expect(result.action).toBe('discarded');
    expect(readPatchJournal(installation.identity)).toBeNull();
    expect(readFileSync(canonicalPath, 'utf8')).toBe(BASELINE);
  });

  it('discards a journal stuck at `baseline_committed` when only immutable storage was touched', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-reconcile-baseline-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);
    writeJournalFixture(baseJournal(installation, { phase: 'baseline_committed', baselineSha256: sha256(BASELINE), baselinePath: '/irrelevant' }));

    const result = await reconcilePatchTransaction(installation, fakeRuntime());
    expect(result.action).toBe('discarded');
    expect(readPatchJournal(installation.identity)).toBeNull();
  });

  it('completes a journal stuck at `binary_committed` by publishing the manifest when the live hash matches the recorded post-image', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-reconcile-binary-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const patchedContent = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    writeFileSync(canonicalPath, patchedContent);
    const installation = makeInstallation(canonicalPath);
    const baselineHash = sha256(BASELINE);
    const baselinePath = ensureBaselineStored({
      identity: installation.identity,
      version: VERSION,
      baselineSha256: baselineHash,
      sourcePath: (() => {
        const p = join(dir, 'baseline-src');
        writeFileSync(p, BASELINE);
        return p;
      })(),
    });
    writeJournalFixture(baseJournal(installation, {
      phase: 'binary_committed',
      baselineSha256: baselineHash,
      baselinePath,
      patchedSha256: sha256(patchedContent),
      patchedSize: Buffer.byteLength(patchedContent),
    }));

    const result = await reconcilePatchTransaction(installation, fakeRuntime());
    expect(result.action).toBe('completed');
    expect(readPatchJournal(installation.identity)).toBeNull();
    const manifest = readManifestV2(installation.identity);
    expect(manifest?.patchedSha256).toBe(sha256(patchedContent));
  });

  it('discards a journal stuck at `binary_committed` when the live hash still matches the pre-image (the rename never landed)', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-reconcile-binary-unchanged-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);
    writeJournalFixture(baseJournal(installation, {
      phase: 'binary_committed',
      expectedPreHash: sha256(BASELINE),
      patchedSha256: 'a-hash-that-never-landed',
    }));

    const result = await reconcilePatchTransaction(installation, fakeRuntime());
    expect(result.action).toBe('discarded');
    expect(readManifestV2(installation.identity)).toBeNull();
  });

  it('leaves a refreshed, unmarked live binary in place when its hash matches neither the pre- nor post-image of the interrupted transaction', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-reconcile-refreshed-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const refreshedContent = `${BASELINE}\n// a completely different claude update landed mid-transaction`;
    writeFileSync(canonicalPath, refreshedContent);
    const installation = makeInstallation(canonicalPath);
    writeJournalFixture(baseJournal(installation, {
      phase: 'binary_committed',
      expectedPreHash: sha256(BASELINE),
      patchedSha256: 'some-other-expected-patched-hash',
    }));

    const before = readFileSync(canonicalPath, 'utf8');
    const result = await reconcilePatchTransaction(installation, fakeRuntime());
    expect(result.action).toBe('left-in-place');
    expect(readFileSync(canonicalPath, 'utf8')).toBe(before);
    expect(readManifestV2(installation.identity)).toBeNull();
    expect(readPatchJournal(installation.identity)).toBeNull();
  });

  it('is a no-op for an already-`completed` journal, and for no journal at all', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-reconcile-completed-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);

    expect((await reconcilePatchTransaction(installation, fakeRuntime())).action).toBe('none');

    writeJournalFixture(baseJournal(installation, { phase: 'completed' }));
    expect((await reconcilePatchTransaction(installation, fakeRuntime())).action).toBe('none');
    clearPatchJournal(installation.identity);
  });
});

describe('conservative legacy migration', () => {
  function legacyManifestFor(binaryPath: string, backupPath: string, live: string, baseline: string): LegacyPatchManifest {
    return {
      binaryPath,
      claudeVersion: VERSION,
      configHash: 'legacy-hash',
      patchedSize: Buffer.byteLength(live),
      patchedSha256: sha256(live),
      backupPath,
      baselineSha256: sha256(baseline),
      patchedAt: '2026-07-20T00:00:00.000Z',
    };
  }

  it('adopts a verified legacy manifest into V2 exactly once, preserving the legacy file untouched', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-migrate-ok-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const backupPath = join(dir, 'claude.orig');
    const patchedContent = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    writeFileSync(canonicalPath, patchedContent);
    writeFileSync(backupPath, BASELINE);
    const legacy = legacyManifestFor(canonicalPath, backupPath, patchedContent, BASELINE);
    const installation = makeInstallation(canonicalPath);

    const result = await migrateLegacyStateIfVerified({ installation, runtime: fakeRuntime(), legacy });
    expect(result.migrated).toBe(true);
    const manifest = readManifestV2(installation.identity);
    expect(manifest?.provenance).toBe('legacy-migrated');
    expect(manifest?.baselineSha256).toBe(sha256(BASELINE));
    expect(existsSync(backupPath)).toBe(true); // legacy backup left untouched
    expect(readFileSync(backupPath, 'utf8')).toBe(BASELINE);

    // Running again is a no-op: V2 state already exists.
    const second = await migrateLegacyStateIfVerified({ installation, runtime: fakeRuntime(), legacy });
    expect(second.migrated).toBe(false);
  });

  it('refuses to migrate when the live target does not exactly match the legacy patched hash', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-migrate-hash-mismatch-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const backupPath = join(dir, 'claude.orig');
    writeFileSync(canonicalPath, `${BASELINE}\nunexpected-drift`);
    writeFileSync(backupPath, BASELINE);
    const legacy = legacyManifestFor(canonicalPath, backupPath, BASELINE, BASELINE); // recorded hash != live hash
    const installation = makeInstallation(canonicalPath);

    const result = await migrateLegacyStateIfVerified({ installation, runtime: fakeRuntime(), legacy });
    expect(result.migrated).toBe(false);
    expect(readManifestV2(installation.identity)).toBeNull();
  });

  it('refuses to migrate when the legacy backup itself carries injection markers', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-migrate-injected-backup-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const backupPath = join(dir, 'claude.orig');
    const patchedContent = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    writeFileSync(canonicalPath, patchedContent);
    writeFileSync(backupPath, patchedContent);
    const legacy = legacyManifestFor(canonicalPath, backupPath, patchedContent, patchedContent);
    const installation = makeInstallation(canonicalPath);

    const result = await migrateLegacyStateIfVerified({ installation, runtime: fakeRuntime(), legacy });
    expect(result.migrated).toBe(false);
    expect(readManifestV2(installation.identity)).toBeNull();
  });

  it('is a no-op when there is no legacy manifest at all', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-migrate-none-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);

    const result = await migrateLegacyStateIfVerified({ installation, runtime: fakeRuntime(), legacy: null });
    expect(result.migrated).toBe(false);
  });
});

describe('evaluatePatchStateV2', () => {
  const manifest: PatchManifestV2 = {
    schemaVersion: 2,
    transformVersion: currentTransformVersion(),
    generation: 1,
    logicalPath: '/opt/claude/claude',
    canonicalPath: '/opt/claude/claude',
    installationKind: 'custom',
    claudeVersion: VERSION,
    baselineSha256: 'baseline-hash',
    baselinePath: '/baselines/claude.orig',
    patchedSha256: 'patched-hash',
    patchedSize: 100,
    semanticFingerprint: 'fp',
    configHash: 'config-hash',
    provenance: 'live',
    completedAt: '2026-07-20T00:00:00.000Z',
  };

  it('classifies an unreadable or ambiguous live target as unsupported', () => {
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest,
      live: { readable: false, version: null, sha256: null, injectionState: 'absent' },
      desiredConfigHash: 'config-hash',
    })).toBe('unsupported');
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest,
      live: { readable: true, version: VERSION, sha256: 'x', injectionState: 'ambiguous' },
      desiredConfigHash: 'config-hash',
    })).toBe('unsupported');
  });

  it('classifies no marker + no manifest as unpatched, and no marker + matching baseline as unpatched', () => {
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest: null,
      live: { readable: true, version: VERSION, sha256: 'x', injectionState: 'absent' },
      desiredConfigHash: 'config-hash',
    })).toBe('unpatched');
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest,
      live: { readable: true, version: VERSION, sha256: 'baseline-hash', injectionState: 'absent' },
      desiredConfigHash: 'config-hash',
    })).toBe('unpatched');
  });

  it('classifies no marker + non-baseline hash + stale manifest as modified (not silently unpatched)', () => {
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest,
      live: { readable: true, version: VERSION, sha256: 'some-other-hash', injectionState: 'absent' },
      desiredConfigHash: 'config-hash',
    })).toBe('modified');
  });

  it('classifies marker present + no manifest as state_missing, never plain unpatched', () => {
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest: null,
      live: { readable: true, version: VERSION, sha256: 'x', injectionState: 'present' },
      desiredConfigHash: 'config-hash',
    })).toBe('state_missing');
  });

  it('classifies a claude version bump as updated', () => {
    expect(evaluatePatchStateV2({
      installationVersion: '9.9.9',
      manifest,
      live: { readable: true, version: '9.9.9', sha256: 'patched-hash', injectionState: 'present' },
      desiredConfigHash: 'config-hash',
    })).toBe('updated');
  });

  it('classifies a hash mismatch with semantic sites intact as modified_but_injected, and broken sites as partially_patched', () => {
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest,
      live: { readable: true, version: VERSION, sha256: 'different-hash', injectionState: 'present' },
      desiredConfigHash: 'config-hash',
      semanticSitesComplete: true,
    })).toBe('modified_but_injected');
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest,
      live: { readable: true, version: VERSION, sha256: 'different-hash', injectionState: 'present' },
      desiredConfigHash: 'config-hash',
      semanticSitesComplete: false,
    })).toBe('partially_patched');
  });

  it('classifies a matching patched hash with a different config as config_stale, and a full match as patched', () => {
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest,
      live: { readable: true, version: VERSION, sha256: 'patched-hash', injectionState: 'present' },
      desiredConfigHash: 'a-new-config-hash',
    })).toBe('config_stale');
    expect(evaluatePatchStateV2({
      installationVersion: VERSION,
      manifest,
      live: { readable: true, version: VERSION, sha256: 'patched-hash', injectionState: 'present' },
      desiredConfigHash: 'config-hash',
    })).toBe('patched');
  });
});

describe('verifyPatchSites (read-only semantic verification)', () => {
  it('reports incomplete when applying the current transform would still change the binary', () => {
    const before = BASELINE;
    const result = verifyPatchSites(before, CONFIG);

    expect(result.complete).toBe(false);
    expect(before).toBe(BASELINE);
    expect(result.results.some(site => site.status === 'OK')).toBe(true);
  });

  it('reports complete only for an idempotent re-check of already-current content', () => {
    const patched = applyLeverframePatches(BASELINE, CONFIG).content;
    const recheck = verifyPatchSites(patched, CONFIG);

    expect(recheck.complete).toBe(true);
    expect(recheck.results.every(site => site.status === 'SKIP')).toBe(true);
  });

  it('treats an optional routing notice anchor mismatch as complete when only the model-resolution call site is present', () => {
    const patched = applyLeverframePatches(BASELINE, CONFIG).content;
    const partialRoutingCallSite = `${patched}let Y=eP(l),ne=fse(aZe(V,Y),Y,H?void 0:f,S);l.agentLifecycle.markTypeInvoked(V.agentType);`;
    const result = verifyPatchSites(partialRoutingCallSite, CONFIG);

    expect(result.complete).toBe(true);
    expect(result.results).toContainEqual({
      status: 'SKIP',
      name: 'routing-notice',
      extra: 'Agent call-site anchor not recognized',
    });
  });

  it('reports incomplete when a required anchor is missing', () => {
    const result = verifyPatchSites('var x = 1;', { 'leverframe:openai:model': { alias: 'model' } });
    expect(result.complete).toBe(false);
  });
});

describe('checkPatchState end-to-end (resolve + reconcile + migrate + classify)', () => {
  it('returns installation: null and state: null when nothing resolves', async () => {
    useTempHome();
    const result = await checkPatchState(join(tmpdir(), 'definitely-missing-claude-binary'));
    expect(result.installation).toBeNull();
    expect(result.state).toBeNull();
  });
});

describe('restorePatchTransactionV2 refusals', () => {
  it('refuses restore when the live binary is not Leverframe-injected', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-restore-not-injected-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    writeFileSync(canonicalPath, BASELINE);
    const installation = makeInstallation(canonicalPath);
    const runtime = fakeRuntime();

    await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'hash-a', manifest: null, trace: false },
      runtime,
    );
    const patchedManifest = readManifestV2(installation.identity)!;

    writeFileSync(canonicalPath, BASELINE);

    const restored = await restorePatchTransactionV2({ installation, manifest: patchedManifest }, runtime);
    expect(restored.ok).toBe(false);
    expect(restored.message).toMatch(/not Leverframe-injected/);
  });

  it('refuses restore with no manifest even though the live binary is injected', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-restore-no-manifest-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const patchedContent = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    writeFileSync(canonicalPath, patchedContent);
    const installation = makeInstallation(canonicalPath);

    const restored = await restorePatchTransactionV2({ installation, manifest: null }, fakeRuntime());
    expect(restored.ok).toBe(false);
    expect(restored.message).toMatch(/no patch manifest/);
  });

  it('refuses restore when the recorded baseline file is missing on disk', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-restore-missing-baseline-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const patchedContent = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    writeFileSync(canonicalPath, patchedContent);
    const installation = makeInstallation(canonicalPath);

    const manifest: PatchManifestV2 = {
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation: 1,
      logicalPath: canonicalPath,
      canonicalPath,
      installationKind: 'custom',
      claudeVersion: VERSION,
      baselineSha256: sha256(BASELINE),
      baselinePath: join(dir, 'does-not-exist.orig'),
      patchedSha256: sha256(patchedContent),
      patchedSize: Buffer.byteLength(patchedContent),
      semanticFingerprint: 'fp',
      configHash: 'hash-a',
      provenance: 'live',
      completedAt: new Date().toISOString(),
    };

    const restored = await restorePatchTransactionV2({ installation, manifest }, fakeRuntime());
    expect(restored.ok).toBe(false);
    expect(restored.message).toMatch(/baseline is missing/);
  });

  it('refuses restore when the stored baseline hash no longer matches the manifest', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-restore-baseline-mismatch-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const patchedContent = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    writeFileSync(canonicalPath, patchedContent);
    const installation = makeInstallation(canonicalPath);

    const tamperedBaselinePath = join(dir, 'tampered.orig');
    writeFileSync(tamperedBaselinePath, `${BASELINE}\ntampered-after-storage`);

    const manifest: PatchManifestV2 = {
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation: 1,
      logicalPath: canonicalPath,
      canonicalPath,
      installationKind: 'custom',
      claudeVersion: VERSION,
      baselineSha256: sha256(BASELINE),
      baselinePath: tamperedBaselinePath,
      patchedSha256: sha256(patchedContent),
      patchedSize: Buffer.byteLength(patchedContent),
      semanticFingerprint: 'fp',
      configHash: 'hash-a',
      provenance: 'live',
      completedAt: new Date().toISOString(),
    };

    const before = readFileSync(canonicalPath);
    const restored = await restorePatchTransactionV2({ installation, manifest }, fakeRuntime());
    expect(restored.ok).toBe(false);
    expect(restored.message).toMatch(/hash does not match/);
    expect(readFileSync(canonicalPath)).toEqual(before);
  });
});

describe('applyPatchTransactionV2 re-patch baseline provenance', () => {
  it('rejects re-patching an already-injected target whose manifest has no baseline on disk', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-repatch-missing-baseline-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const patchedContent = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    writeFileSync(canonicalPath, patchedContent);
    const installation = makeInstallation(canonicalPath);

    const manifest: PatchManifestV2 = {
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation: 1,
      logicalPath: canonicalPath,
      canonicalPath,
      installationKind: 'custom',
      claudeVersion: VERSION,
      baselineSha256: sha256(BASELINE),
      baselinePath: join(dir, 'does-not-exist.orig'),
      patchedSha256: sha256(patchedContent),
      patchedSize: Buffer.byteLength(patchedContent),
      semanticFingerprint: 'fp',
      configHash: 'old-hash',
      provenance: 'live',
      completedAt: new Date().toISOString(),
    };

    const before = readFileSync(canonicalPath);
    const outcome = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'new-hash', manifest, trace: false },
      fakeRuntime(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/baseline is missing/);
    expect(readFileSync(canonicalPath)).toEqual(before);
  });

  it('rejects re-patching when the saved baseline hash no longer matches the manifest (contaminated/tampered baseline)', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-repatch-contaminated-baseline-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const patchedContent = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    writeFileSync(canonicalPath, patchedContent);
    const installation = makeInstallation(canonicalPath);

    const contaminatedBaselinePath = join(dir, 'contaminated.orig');
    writeFileSync(contaminatedBaselinePath, `${BASELINE}\n/*ccpatch:ctx*/`);

    const manifest: PatchManifestV2 = {
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation: 1,
      logicalPath: canonicalPath,
      canonicalPath,
      installationKind: 'custom',
      claudeVersion: VERSION,
      baselineSha256: sha256(BASELINE), // recorded hash does not match the file on disk
      baselinePath: contaminatedBaselinePath,
      patchedSha256: sha256(patchedContent),
      patchedSize: Buffer.byteLength(patchedContent),
      semanticFingerprint: 'fp',
      configHash: 'old-hash',
      provenance: 'live',
      completedAt: new Date().toISOString(),
    };

    const before = readFileSync(canonicalPath);
    const outcome = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'new-hash', manifest, trace: false },
      fakeRuntime(),
    );
    expect(outcome.ok).toBe(false);
    expect(readFileSync(canonicalPath)).toEqual(before);
  });

  it('accepts re-patching an already-injected target from its valid saved baseline (provenance: backup)', async () => {
    useTempHome();
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-repatch-valid-baseline-'));
    dirs.push(dir);
    const canonicalPath = join(dir, 'claude');
    const installation = makeInstallation(canonicalPath);
    const runtime = fakeRuntime();
    writeFileSync(canonicalPath, BASELINE);

    const first = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'hash-a', manifest: null, trace: false },
      runtime,
    );
    expect(first.ok).toBe(true);
    const manifest = readManifestV2(installation.identity)!;

    const second = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'hash-b', manifest, trace: false },
      runtime,
    );
    expect(second.ok).toBe(true);
    const manifest2 = readManifestV2(installation.identity)!;
    expect(manifest2.provenance).toBe('backup');
    expect(manifest2.baselineSha256).toBe(sha256(BASELINE));
  });
});

describe('per-target patch lock (src/patch-lock.ts, backed by the registry lock primitive)', () => {
  it('refuses the lock while a live owner holds it, and grants it once released', () => {
    useTempHome();
    const identity = 'lock-identity-live';
    const first = tryAcquirePatchTargetLock(identity, { isAlive: () => true });
    expect(first).not.toBeNull();
    expect(tryAcquirePatchTargetLock(identity, { isAlive: () => true })).toBeNull();
    first!.release();
    const second = tryAcquirePatchTargetLock(identity, { isAlive: () => true });
    expect(second).not.toBeNull();
    second!.release();
  });

  it('steals a lock abandoned by a dead owner', () => {
    useTempHome();
    const identity = 'lock-identity-dead';
    const first = tryAcquirePatchTargetLock(identity, { isAlive: () => false });
    expect(first).not.toBeNull();
    const second = tryAcquirePatchTargetLock(identity, { isAlive: () => false });
    expect(second).not.toBeNull();
    second!.release();
  });

  it('never evicts a live-owned lock purely by age', () => {
    useTempHome();
    const identity = 'lock-identity-age';
    const owner = tryAcquirePatchTargetLock(identity, {
      now: () => Date.now() - 60 * 60 * 1000,
      isAlive: () => true,
    });
    expect(owner).not.toBeNull();
    expect(tryAcquirePatchTargetLock(identity, { now: () => Date.now(), isAlive: () => true })).toBeNull();
    owner!.release();
  });

  it('release is token-owned: releasing a lease after another owner replaced it does not tear down the new owner\'s lock', () => {
    useTempHome();
    const identity = 'lock-identity-token';
    const first = tryAcquirePatchTargetLock(identity, { isAlive: () => false });
    expect(first).not.toBeNull();
    const second = tryAcquirePatchTargetLock(identity, { isAlive: () => false });
    expect(second).not.toBeNull();
    first!.release();
    expect(existsSync(getPatchTargetLockPath(identity))).toBe(true);
    second!.release();
  });
});
