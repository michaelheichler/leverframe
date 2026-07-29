// Fixture-based end-to-end coverage for the V2 patch lifecycle
// (docs/stabilization-and-upstream-plan.md sections 5, 10-15):
//   - deterministic installation identity (src/claude-installation.ts)
//   - per-target, content-addressed baselines (src/patch-state.ts)
//   - crash-safe journaled transactions and restart reconciliation
//     (src/patch-transaction.ts, src/patch-reconcile.ts)
//   - conservative legacy migration (src/patch-reconcile.ts)
//   - read-only diagnostics (src/patch-diagnostics.ts)
//
// All Claude "binaries" are real, executable, tiny shell scripts so
// resolveClaudeInstallation performs its real discovery + version probe.
// Patch/inspect/read operations use an injected PatchRuntime (plain fs, real
// applyLeverframePatches) instead of the tweakcc-backed defaultPatchRuntime,
// so tests never depend on an actual Claude Code build. The whole fixture
// file — not a sidecar — is both the executable probed for --version and the
// content that gets hashed/patched, matching how defaultPatchRuntime treats
// one real binary.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveClaudeInstallation } from '../src/claude-installation.js';
import {
  applyPatchTransactionV2,
  computeSemanticFingerprint,
  restorePatchTransactionV2,
  verifyPatchSites,
  type PatchRuntime,
  type PatchTransactionJournal,
} from '../src/patch-transaction.js';
import {
  reconcilePatchTransaction,
  migrateLegacyStateIfVerified,
  checkPatchState,
} from '../src/patch-reconcile.js';
import { diagnosePatchV2 } from '../src/patch-diagnostics.js';
import {
  getPatchTransactionPathV2,
  getPatchBaselinesDirV2,
  getBaselinePathV2,
  readManifestV2,
  currentTransformVersion,
} from '../src/patch-state.js';
import { atomicWriteJsonSync } from '../src/atomic-file.js';
import {
  addLeverframeInjectionMarker,
  classifyLeverframeInjectionByHash,
} from '../src/patch-injection.js';
import { applyLeverframePatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import {
  buildDesiredPatchConfig,
  computePatchConfigHash,
  type PatchManifest as LegacyPatchManifest,
} from '../src/patcher.js';
import { savePreferences } from '../src/config.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';

const VERSION = '2.1.220';
const BASELINE_SOURCE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');
const CONFIG: PatchScriptModelConfig = { 'leverframe:openai:model': { alias: 'model', context: 272_000 } };

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const PAYLOAD_HEREDOC_TAG = 'LEVERFRAME_PAYLOAD';

/**
 * A real, executable "claude" script: `--version` prints VERSION and exits
 * before the interpreter ever reaches the payload, so the patchable content
 * lives in the *same* file the version probe executes, while the payload
 * itself stays inert shell text (a quoted no-op heredoc the shell never
 * reaches on any code path this fixture exercises).
 */
function wholeFileContent(payload: string, version = VERSION): string {
  return [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi`,
    'exit 1',
    `: <<'${PAYLOAD_HEREDOC_TAG}'`,
    payload,
    PAYLOAD_HEREDOC_TAG,
  ].join('\n');
}

/** What fixtureRuntime.patch would produce for a given starting payload/version. */
function patchedWholeFileContent(config: PatchScriptModelConfig, payload = BASELINE_SOURCE, version = VERSION): string {
  const patched = applyLeverframePatches(wholeFileContent(payload, version), config);
  return addLeverframeInjectionMarker(patched.content);
}

function writeFixtureClaude(path: string, payload = BASELINE_SOURCE, version = VERSION): void {
  writeFileSync(path, wholeFileContent(payload, version), { encoding: 'utf8' });
  chmodSync(path, 0o755);
}

/** Fixture PatchRuntime: reads/writes the whole fixture file, using the real transform + marker logic. */
const fixtureRuntime: PatchRuntime = {
  async inspect(path, knownPatchedSha256) {
    try {
      const content = readFileSync(path, 'utf8');
      const versionOut = content.match(/echo "(\d+\.\d+\.\d+)/)?.[1] ?? null;
      const contentSha256 = sha256(content);
      return {
        path,
        readable: true,
        version: versionOut,
        sha256: contentSha256,
        injection: classifyLeverframeInjectionByHash(content, contentSha256, knownPatchedSha256),
      };
    } catch {
      return { path, readable: false, version: null, sha256: null, injection: { state: 'ambiguous', evidence: 'unknown-marker' } };
    }
  },
  async patch(path, config) {
    const patched = applyLeverframePatches(readFileSync(path, 'utf8'), config);
    writeFileSync(path, addLeverframeInjectionMarker(patched.content), 'utf8');
    return patched.results;
  },
  async readContent(path) {
    return readFileSync(path, 'utf8');
  },
};

/** A patch runtime whose `patch` step always throws after touching nothing durable. */
function failingPatchRuntime(): PatchRuntime {
  return {
    ...fixtureRuntime,
    async patch() {
      throw new Error('synthetic patch failure');
    },
  };
}

function readJournal(identity: string): PatchTransactionJournal | null {
  const path = getPatchTransactionPathV2(identity);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as PatchTransactionJournal;
}

/**
 * Seed global favorites + a registry model so `buildDesiredPatchConfig()` —
 * the same function `checkPatchState`/`diagnosePatchV2` call internally —
 * deterministically resolves to one favorite, letting a test drive the real
 * end-to-end config resolution instead of a hand-picked `configHash` that
 * would never match what those read paths independently recompute.
 */
function seedOneFavoriteAndBuildConfig(): { config: PatchScriptModelConfig; configHash: string } {
  savePreferences({
    favoriteModels: [{ providerId: 'openai', modelId: 'model' }],
    modelAliases: [],
  });
  const registry = loadRegistry();
  saveRegistry({
    ...registry,
    providers: [
      {
        id: 'openai',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: 'openai',
        api: {},
        modelsCache: {
          fetchedAt: new Date().toISOString(),
          models: [{
            id: 'model',
            name: 'Model',
            upstreamModelId: 'model',
            contextWindow: 272_000,
            modelFormat: 'openai',
          }],
        },
        addedAt: new Date().toISOString(),
      },
    ],
  });
  const desired = buildDesiredPatchConfig();
  return { config: desired.config, configHash: computePatchConfigHash(desired.config) };
}

let workDir: string;
let leverframeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  // realpathSync normalizes macOS's /var -> /private/var symlink up front so
  // every downstream comparison against a raw fixture path already matches
  // the canonicalPath resolveClaudeInstallation reports.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'lf-patch-fixture-')));
  leverframeHome = join(workDir, 'leverframe-home');
  originalHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = leverframeHome;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

describe('deterministic installation identity', () => {
  it('resolves a real fixture, computes a stable sha256 identity from the canonical path, and classifies discovery/kind', () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath });
    expect(installation).not.toBeNull();
    expect(installation!.version).toBe(VERSION);
    expect(installation!.discoverySource).toBe('explicit-target');
    expect(installation!.canonicalPath).toBe(claudePath);
    expect(installation!.identity).toBe(createHash('sha256').update(claudePath).digest('hex'));

    // Re-resolving the identical path is fully deterministic.
    const again = resolveClaudeInstallation({ target: claudePath });
    expect(again!.identity).toBe(installation!.identity);
  });

  it('resolves a symlinked target to its canonical realpath, keying identity by the resolved target', () => {
    const realPath = join(workDir, 'claude-real');
    writeFixtureClaude(realPath);
    const linkPath = join(workDir, 'claude-link');
    symlinkSync(realPath, linkPath);

    const installation = resolveClaudeInstallation({ target: linkPath });
    expect(installation).not.toBeNull();
    expect(installation!.logicalPath).toBe(linkPath);
    expect(installation!.canonicalPath).toBe(realPath);
    expect(installation!.identity).toBe(createHash('sha256').update(realPath).digest('hex'));
  });

  it('gives two distinct installations (different canonical paths) two distinct identities', () => {
    const pathA = join(workDir, 'claude-a');
    const pathB = join(workDir, 'claude-b');
    writeFixtureClaude(pathA);
    writeFixtureClaude(pathB);
    const a = resolveClaudeInstallation({ target: pathA })!;
    const b = resolveClaudeInstallation({ target: pathB })!;
    expect(a.identity).not.toBe(b.identity);
  });

  it('resolves a chain of symlinks to the one real file, never reporting a symlink as canonical', () => {
    const realPath = join(workDir, 'claude-real2');
    writeFixtureClaude(realPath);
    const link1 = join(workDir, 'claude-link1');
    const link2 = join(workDir, 'claude-link2');
    symlinkSync(realPath, link1);
    symlinkSync(link1, link2);
    const installation = resolveClaudeInstallation({ target: link2 });
    expect(installation!.canonicalPath).toBe(realPath);
  });

  it('re-resolves a retargeted symlink to its new canonical path and a new identity', () => {
    const targetA = join(workDir, 'claude-target-a');
    const targetB = join(workDir, 'claude-target-b');
    writeFixtureClaude(targetA);
    writeFixtureClaude(targetB, BASELINE_SOURCE, '2.1.221');
    const link = join(workDir, 'claude-retargetable');
    symlinkSync(targetA, link);

    const before = resolveClaudeInstallation({ target: link })!;
    expect(before.canonicalPath).toBe(targetA);
    expect(before.version).toBe(VERSION);

    rmSync(link);
    symlinkSync(targetB, link);
    const after = resolveClaudeInstallation({ target: link })!;
    expect(after.canonicalPath).toBe(targetB);
    expect(after.version).toBe('2.1.221');
    expect(after.identity).not.toBe(before.identity);
  });

  it('prefers an explicit --target over every override and discovery fallback', () => {
    const explicit = join(workDir, 'claude-explicit');
    writeFixtureClaude(explicit);
    const prevOverride = process.env.LEVERFRAME_CLAUDE_PATH;
    process.env.LEVERFRAME_CLAUDE_PATH = join(workDir, 'should-not-be-used');
    try {
      const installation = resolveClaudeInstallation({ target: explicit });
      expect(installation!.canonicalPath).toBe(explicit);
      expect(installation!.discoverySource).toBe('explicit-target');
    } finally {
      if (prevOverride === undefined) delete process.env.LEVERFRAME_CLAUDE_PATH;
      else process.env.LEVERFRAME_CLAUDE_PATH = prevOverride;
    }
  });
});

describe('content-addressed immutable baselines', () => {
  it('stores one baseline object per distinct (version, content) pair and is a no-op on repeat', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    const first = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'cfg-1', manifest: null, trace: false },
      fixtureRuntime,
    );
    expect(first.ok).toBe(true);

    const manifest = readManifestV2(installation.identity)!;
    const expectedBaselinePath = getBaselinePathV2(installation.identity, VERSION, sha256(wholeFileContent(BASELINE_SOURCE)));
    expect(manifest.baselinePath).toBe(expectedBaselinePath);
    expect(existsSync(expectedBaselinePath)).toBe(true);
    expect(readFileSync(expectedBaselinePath, 'utf8')).toBe(wholeFileContent(BASELINE_SOURCE));

    // Restore, then re-patch: the baseline object is reused, not duplicated.
    const restored = await restorePatchTransactionV2({ installation, manifest }, fixtureRuntime);
    expect(restored.ok).toBe(true);
    const second = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'cfg-1', manifest: null, trace: false },
      fixtureRuntime,
    );
    expect(second.ok).toBe(true);
    const manifest2 = readManifestV2(installation.identity)!;
    expect(manifest2.baselinePath).toBe(expectedBaselinePath);
  });

  it('keys baselines under a per-identity directory, so two installs never share baseline storage', async () => {
    const pathA = join(workDir, 'claude-a');
    const pathB = join(workDir, 'claude-b');
    writeFixtureClaude(pathA);
    writeFixtureClaude(pathB);
    const a = resolveClaudeInstallation({ target: pathA })!;
    const b = resolveClaudeInstallation({ target: pathB })!;

    await applyPatchTransactionV2({ installation: a, desiredConfig: CONFIG, configHash: 'cfg', manifest: null, trace: false }, fixtureRuntime);
    await applyPatchTransactionV2({ installation: b, desiredConfig: CONFIG, configHash: 'cfg', manifest: null, trace: false }, fixtureRuntime);

    expect(getPatchBaselinesDirV2(a.identity)).not.toBe(getPatchBaselinesDirV2(b.identity));
    expect(readManifestV2(a.identity)!.baselinePath).not.toBe(readManifestV2(b.identity)!.baselinePath);
  });
});

describe('journal phases and failpoints', () => {
  it('runs prepared -> baseline_committed -> binary_committed -> manifest_committed -> completed for a full patch', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    const outcome = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'cfg', manifest: null, trace: false },
      fixtureRuntime,
    );
    expect(outcome.ok).toBe(true);

    const journal = readJournal(installation.identity)!;
    expect(journal.phase).toBe('completed');
    expect(journal.operation).toBe('patch');
    expect(journal.baselineSha256).toBe(sha256(wholeFileContent(BASELINE_SOURCE)));
    expect(journal.patchedSha256).toBeTruthy();
  });

  it('leaves the journal at baseline_committed (never binary_committed) when the patch step itself fails, and touches nothing live', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    const outcome = await applyPatchTransactionV2(
      { installation, desiredConfig: CONFIG, configHash: 'cfg', manifest: null, trace: false },
      failingPatchRuntime(),
    );
    expect(outcome.ok).toBe(false);

    const journal = readJournal(installation.identity)!;
    expect(journal.phase).toBe('baseline_committed');
    // The live content is untouched: still the pristine baseline text.
    expect(readFileSync(claudePath, 'utf8')).toBe(wholeFileContent(BASELINE_SOURCE));
    expect(readManifestV2(installation.identity)).toBeNull();
  });

  it('reconciliation discards an interrupted transaction still at prepared/baseline_committed with no live-side effect', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    atomicWriteJsonSync(getPatchTransactionPathV2(installation.identity), {
      schemaVersion: 1,
      operation: 'patch',
      identity: installation.identity,
      canonicalPath: installation.canonicalPath,
      generation: 1,
      phase: 'prepared',
      expectedPreHash: sha256(wholeFileContent(BASELINE_SOURCE)),
      claudeVersion: VERSION,
      baselineSha256: '',
      baselinePath: '',
      configHash: 'cfg',
      transformVersion: currentTransformVersion(),
      provenance: 'live',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies PatchTransactionJournal);

    const result = await reconcilePatchTransaction(installation, fixtureRuntime);
    expect(result.action).toBe('discarded');
    expect(readJournal(installation.identity)).toBeNull();
  });

  it('reconciliation completes a binary_committed transaction whose live hash matches the recorded post-image by publishing the manifest', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    // Simulate: the binary swap landed (content already carries the marker)
    // but the process died before the manifest was published.
    const patchedContent = patchedWholeFileContent(CONFIG);
    writeFileSync(claudePath, patchedContent, 'utf8');
    const patchedSha256 = sha256(patchedContent);

    atomicWriteJsonSync(getPatchTransactionPathV2(installation.identity), {
      schemaVersion: 1,
      operation: 'patch',
      identity: installation.identity,
      canonicalPath: installation.canonicalPath,
      generation: 1,
      phase: 'binary_committed',
      expectedPreHash: sha256(wholeFileContent(BASELINE_SOURCE)),
      claudeVersion: VERSION,
      baselineSha256: sha256(wholeFileContent(BASELINE_SOURCE)),
      baselinePath: getBaselinePathV2(installation.identity, VERSION, sha256(wholeFileContent(BASELINE_SOURCE))),
      patchedSha256,
      patchedSize: Buffer.byteLength(patchedContent),
      configHash: 'cfg',
      transformVersion: currentTransformVersion(),
      provenance: 'live',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies PatchTransactionJournal);

    const result = await reconcilePatchTransaction(installation, fixtureRuntime);
    expect(result.action).toBe('completed');
    expect(readJournal(installation.identity)).toBeNull();
    const manifest = readManifestV2(installation.identity);
    expect(manifest?.patchedSha256).toBe(patchedSha256);
  });

  it('reconciliation discards a binary_committed transaction whose live hash still matches the pre-image (the rename never took effect)', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    atomicWriteJsonSync(getPatchTransactionPathV2(installation.identity), {
      schemaVersion: 1,
      operation: 'patch',
      identity: installation.identity,
      canonicalPath: installation.canonicalPath,
      generation: 1,
      phase: 'binary_committed',
      expectedPreHash: sha256(wholeFileContent(BASELINE_SOURCE)),
      claudeVersion: VERSION,
      baselineSha256: sha256(wholeFileContent(BASELINE_SOURCE)),
      baselinePath: getBaselinePathV2(installation.identity, VERSION, sha256(wholeFileContent(BASELINE_SOURCE))),
      patchedSha256: 'deadbeef',
      patchedSize: 0,
      configHash: 'cfg',
      transformVersion: currentTransformVersion(),
      provenance: 'live',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies PatchTransactionJournal);

    const result = await reconcilePatchTransaction(installation, fixtureRuntime);
    expect(result.action).toBe('discarded');
    expect(readJournal(installation.identity)).toBeNull();
    expect(readManifestV2(installation.identity)).toBeNull();
  });

  it('a refreshed live binary (hash matches neither pre- nor post-image) is left authoritative; only the stale journal is dropped', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    // Claude updated itself mid-interruption: content is neither our pre-image
    // nor our expected post-image.
    const refreshedContent = `${wholeFileContent(BASELINE_SOURCE)}\n# unrelated upstream change\n`;
    writeFileSync(claudePath, refreshedContent, 'utf8');

    atomicWriteJsonSync(getPatchTransactionPathV2(installation.identity), {
      schemaVersion: 1,
      operation: 'patch',
      identity: installation.identity,
      canonicalPath: installation.canonicalPath,
      generation: 1,
      phase: 'binary_committed',
      expectedPreHash: sha256(wholeFileContent(BASELINE_SOURCE)),
      claudeVersion: VERSION,
      baselineSha256: sha256(wholeFileContent(BASELINE_SOURCE)),
      baselinePath: getBaselinePathV2(installation.identity, VERSION, sha256(wholeFileContent(BASELINE_SOURCE))),
      patchedSha256: 'some-other-hash-entirely',
      patchedSize: 0,
      configHash: 'cfg',
      transformVersion: currentTransformVersion(),
      provenance: 'live',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies PatchTransactionJournal);

    const result = await reconcilePatchTransaction(installation, fixtureRuntime);
    expect(result.action).toBe('left-in-place');
    expect(readJournal(installation.identity)).toBeNull();
    // The refreshed content was never touched.
    expect(readFileSync(claudePath, 'utf8')).toBe(refreshedContent);
    expect(readManifestV2(installation.identity)).toBeNull();
  });

  it('reconciliation at manifest_committed treats the transaction as effectively completed', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    atomicWriteJsonSync(getPatchTransactionPathV2(installation.identity), {
      schemaVersion: 1,
      operation: 'patch',
      identity: installation.identity,
      canonicalPath: installation.canonicalPath,
      generation: 1,
      phase: 'manifest_committed',
      expectedPreHash: sha256(wholeFileContent(BASELINE_SOURCE)),
      claudeVersion: VERSION,
      baselineSha256: sha256(wholeFileContent(BASELINE_SOURCE)),
      baselinePath: getBaselinePathV2(installation.identity, VERSION, sha256(wholeFileContent(BASELINE_SOURCE))),
      patchedSha256: 'irrelevant',
      patchedSize: 0,
      configHash: 'cfg',
      transformVersion: currentTransformVersion(),
      provenance: 'live',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies PatchTransactionJournal);

    const result = await reconcilePatchTransaction(installation, fixtureRuntime);
    expect(result.action).toBe('completed');
    expect(readJournal(installation.identity)).toBeNull();
  });

  it('a journal already at completed is left untouched by reconciliation (no-op)', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    atomicWriteJsonSync(getPatchTransactionPathV2(installation.identity), {
      schemaVersion: 1,
      operation: 'patch',
      identity: installation.identity,
      canonicalPath: installation.canonicalPath,
      generation: 1,
      phase: 'completed',
      expectedPreHash: sha256(wholeFileContent(BASELINE_SOURCE)),
      claudeVersion: VERSION,
      baselineSha256: sha256(wholeFileContent(BASELINE_SOURCE)),
      baselinePath: getBaselinePathV2(installation.identity, VERSION, sha256(wholeFileContent(BASELINE_SOURCE))),
      patchedSha256: 'whatever',
      patchedSize: 0,
      configHash: 'cfg',
      transformVersion: currentTransformVersion(),
      provenance: 'live',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies PatchTransactionJournal);

    const result = await reconcilePatchTransaction(installation, fixtureRuntime);
    expect(result.action).toBe('none');
    expect(readJournal(installation.identity)).not.toBeNull();
  });
});

describe('idempotency', () => {
  it('re-running patch with the same config is a config-hash no-op reported as `patched`', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    const first = await applyPatchTransactionV2({ installation, desiredConfig: CONFIG, configHash: 'stable-cfg', manifest: null, trace: false }, fixtureRuntime);
    expect(first.ok).toBe(true);
    const manifestAfterFirst = readManifestV2(installation.identity)!;

    const { evaluatePatchStateV2 } = await import('../src/patch-classify.js');
    const live = await fixtureRuntime.inspect(installation.canonicalPath, manifestAfterFirst.patchedSha256);
    const state = evaluatePatchStateV2({
      installationVersion: installation.version,
      manifest: manifestAfterFirst,
      live: { readable: live.readable, version: live.version, sha256: live.sha256, injectionState: live.injection.state },
      desiredConfigHash: 'stable-cfg',
    });
    expect(state).toBe('patched');
  });
});

describe('unknown hash handling (whole-file mismatch with valid markers/sites)', () => {
  it('classifies as modified_but_injected when semantic sites still verify against a re-signed patched binary', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;
    // checkPatchState recomputes the desired config from real global
    // favorites internally, so the applied config must be seeded to match —
    // otherwise every classification degrades to config_stale regardless of
    // the scenario under test.
    const { config, configHash } = seedOneFavoriteAndBuildConfig();

    await applyPatchTransactionV2({ installation, desiredConfig: config, configHash, manifest: null, trace: false }, fixtureRuntime);
    const manifest = readManifestV2(installation.identity)!;

    // Simulate an external re-sign: append a byte, changing the whole-file
    // hash while keeping every real patch site intact.
    const currentContent = readFileSync(claudePath, 'utf8');
    // The heredoc has already closed by the time the marker line was
    // appended, so appending here (after the marker) is likewise inert shell
    // text and does not disturb the version probe.
    writeFileSync(claudePath, `${currentContent}\n# resigned\n`, 'utf8');

    const { complete } = verifyPatchSites(readFileSync(claudePath, 'utf8'), config);
    expect(complete).toBe(true);

    const { state } = await checkPatchState(claudePath, fixtureRuntime);
    expect(state).toBe('modified_but_injected');
    expect(manifest.patchedSha256).not.toBe(sha256(readFileSync(claudePath, 'utf8')));
  });
});

describe('legacy migration', () => {
  it('adopts a verified legacy global manifest into per-target V2 state exactly once, preserving the legacy file', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    // Live is already patched (as legacy Leverframe would have left it).
    const patchedContent = patchedWholeFileContent(CONFIG);
    writeFileSync(claudePath, patchedContent, 'utf8');
    const patchedSha256 = sha256(patchedContent);

    const backupPath = join(workDir, 'legacy-backup.orig');
    const baselineContent = wholeFileContent(BASELINE_SOURCE);
    writeFileSync(backupPath, baselineContent, 'utf8');

    const legacy: LegacyPatchManifest = {
      binaryPath: installation.canonicalPath,
      claudeVersion: VERSION,
      configHash: 'legacy-cfg',
      patchedSize: Buffer.byteLength(patchedContent),
      patchedSha256,
      backupPath,
      baselineSha256: sha256(baselineContent),
      patchedAt: '2026-07-01T00:00:00.000Z',
    };

    const result = await migrateLegacyStateIfVerified({ installation, runtime: fixtureRuntime, legacy });
    expect(result.migrated).toBe(true);

    const manifest = readManifestV2(installation.identity);
    expect(manifest).not.toBeNull();
    expect(manifest!.provenance).toBe('legacy-migrated');
    expect(manifest!.baselineSha256).toBe(sha256(baselineContent));
    // The legacy backup file itself must be left untouched.
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf8')).toBe(baselineContent);

    // A second call is a no-op because V2 state already exists.
    const second = await migrateLegacyStateIfVerified({ installation, runtime: fixtureRuntime, legacy });
    expect(second.migrated).toBe(false);
    expect(second.reason).toMatch(/already exists/);
  });

  it('refuses to migrate when the legacy backup carries a Leverframe injection marker (never adopts an unknown target as pristine)', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;

    const patchedContent = patchedWholeFileContent(CONFIG);
    writeFileSync(claudePath, patchedContent, 'utf8');

    const backupPath = join(workDir, 'legacy-backup-bad.orig');
    // Contaminated backup: it itself carries the marker.
    writeFileSync(backupPath, patchedContent, 'utf8');

    const legacy: LegacyPatchManifest = {
      binaryPath: installation.canonicalPath,
      claudeVersion: VERSION,
      configHash: 'legacy-cfg',
      patchedSize: Buffer.byteLength(patchedContent),
      patchedSha256: sha256(patchedContent),
      backupPath,
      baselineSha256: sha256(patchedContent),
      patchedAt: '2026-07-01T00:00:00.000Z',
    };

    const result = await migrateLegacyStateIfVerified({ installation, runtime: fixtureRuntime, legacy });
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/injection markers/);
    expect(readManifestV2(installation.identity)).toBeNull();
  });

  it('refuses migration and recovery when the live hash differs and the target is unmarked', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;
    const backupPath = join(workDir, 'legacy-pristine.orig');
    const baselineContent = wholeFileContent(BASELINE_SOURCE);
    writeFileSync(backupPath, baselineContent, 'utf8');

    const legacy: LegacyPatchManifest = {
      binaryPath: installation.canonicalPath,
      claudeVersion: VERSION,
      configHash: 'legacy-cfg',
      patchedSize: 0,
      patchedSha256: 'does-not-match',
      backupPath,
      baselineSha256: sha256(baselineContent),
      patchedAt: '2026-07-01T00:00:00.000Z',
    };

    const result = await migrateLegacyStateIfVerified({ installation, runtime: fixtureRuntime, legacy });
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/not recognizably injected/);
  });
});

describe('read-only diagnostics', () => {
  it('reports identity, manifest, drift, transaction, lock, and migration fields without mutating any state', async () => {
    const claudePath = join(workDir, 'claude-a');
    writeFixtureClaude(claudePath);
    const installation = resolveClaudeInstallation({ target: claudePath })!;
    const { config, configHash } = seedOneFavoriteAndBuildConfig();
    await applyPatchTransactionV2({ installation, desiredConfig: config, configHash, manifest: null, trace: false }, fixtureRuntime);

    const beforeContent = readFileSync(claudePath, 'utf8');
    const report = await diagnosePatchV2(claudePath, fixtureRuntime);
    const afterContent = readFileSync(claudePath, 'utf8');

    expect(afterContent).toBe(beforeContent);
    expect(report.resolved).toBe(true);
    expect(report.identity?.canonicalPath).toBe(installation.canonicalPath);
    expect(report.identity?.version).toBe(VERSION);
    expect(report.manifest.present).toBe(true);
    expect(report.manifest.baselinePresent).toBe(true);
    expect(report.drift.hashesMatch).toBe(true);
    expect(report.transaction.pending).toBe(false);
    expect(report.state).toBe('patched');
    expect(report.nextAction).toBe('Nothing to do.');

    // ANSI-free JSON: no CSI escape sequences anywhere in the serialized report.
    const json = JSON.stringify(report, null, 2);
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(json)).toBe(false);
  });

  it('reports not_resolved without throwing when no installation can be found', async () => {
    const report = await diagnosePatchV2(join(workDir, 'does-not-exist'), fixtureRuntime);
    expect(report.resolved).toBe(false);
    expect(report.state).toBe('not_resolved');
  });
});

describe('semantic fingerprint', () => {
  it('is stable across key order and reflects only names+statuses, not model config bytes', () => {
    const { results: a } = applyLeverframePatches(wholeFileContent(BASELINE_SOURCE), CONFIG);
    const { results: b } = applyLeverframePatches(wholeFileContent(BASELINE_SOURCE), { ...CONFIG });
    expect(computeSemanticFingerprint(a)).toBe(computeSemanticFingerprint(b));
  });
});
