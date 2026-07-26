import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addLeverframeInjectionMarker,
  applyPatchTransaction,
  choosePatchBaseline,
  classifyLeverframeInjection,
  evaluatePatchState,
  LEVERFRAME_INJECTION_MARKER,
  restorePatchTransaction,
  type PatchBinaryInspection,
  type PatchBinaryRuntime,
  type PatchManifest,
} from '../src/patcher.js';
import {
  applyLeverframePatches,
} from '../src/patch-transforms.js';

const VERSION = '2.1.220';
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

function inspection(
  path: string,
  content: string,
  injection = classifyLeverframeInjection(content, sha256(content), null, path),
  version = VERSION,
): PatchBinaryInspection {
  return {
    path,
    readable: true,
    version,
    sha256: sha256(content),
    injection,
  };
}

function runtime(failPatch = false): PatchBinaryRuntime {
  return {
    inspect: async (path, manifest) => {
      const content = readFileSync(path, 'utf8');
      return inspection(
        path,
        content,
        classifyLeverframeInjection(content, sha256(content), manifest ?? null, path),
      );
    },
    patch: async (path, config) => {
      if (failPatch) throw new Error('synthetic patch failure');
      const patched = applyLeverframePatches(readFileSync(path, 'utf8'), config);
      writeFileSync(path, addLeverframeInjectionMarker(patched.content));
      return patched.results;
    },
  };
}

function manifest(binaryPath: string, backupPath: string, live: string, baseline: string): PatchManifest {
  return {
    binaryPath,
    claudeVersion: VERSION,
    configHash: 'old-config',
    patchedSize: Buffer.byteLength(live),
    patchedSha256: sha256(live),
    backupPath,
    baselineSha256: sha256(baseline),
    patchedAt: '2026-07-26T00:00:00.000Z',
  };
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('pre-Leverframe baseline selection', () => {
  it('adopts an unmarked live binary even when a stale same-version backup exists', () => {
    const binaryPath = '/claude';
    const backupPath = '/backup';
    const live = inspection(binaryPath, BASELINE);
    const staleBackup = inspection(backupPath, `${BASELINE}\nstale`);

    expect(choosePatchBaseline('patch', live, staleBackup, null, {
      binaryPath,
      backupPath,
      version: VERSION,
    })).toEqual({ ok: true, source: 'live' });
  });

  it('rejects a version-mismatched baseline for an injected live binary', () => {
    const binaryPath = '/claude';
    const backupPath = '/backup';
    const liveContent = `${BASELINE}\n${LEVERFRAME_INJECTION_MARKER}`;
    const saved = manifest(binaryPath, backupPath, liveContent, BASELINE);

    expect(choosePatchBaseline(
      'patch',
      inspection(binaryPath, liveContent),
      inspection(backupPath, BASELINE, undefined, '2.1.219'),
      saved,
      { binaryPath, backupPath, version: VERSION },
    )).toMatchObject({ ok: false, reason: expect.stringMatching(/version/) });
  });

  it('rejects a contaminated baseline for an injected live binary', () => {
    const binaryPath = '/claude';
    const backupPath = '/backup';
    const liveContent = `${BASELINE}\n${LEVERFRAME_INJECTION_MARKER}`;
    const contaminated = `${BASELINE}\n/*ccpatch:ctx*/`;
    const saved = manifest(binaryPath, backupPath, liveContent, contaminated);

    expect(choosePatchBaseline(
      'patch',
      inspection(binaryPath, liveContent),
      inspection(backupPath, contaminated),
      saved,
      { binaryPath, backupPath, version: VERSION },
    )).toMatchObject({ ok: false, reason: expect.stringMatching(/injected/) });
  });

  it('rejects a legacy markerless patched binary saved as its own baseline', () => {
    const binaryPath = '/claude';
    const backupPath = '/backup';
    const liveContent = `${BASELINE}\nlegacy-patched`;
    const saved = manifest(binaryPath, backupPath, liveContent, liveContent);
    const liveInjection = classifyLeverframeInjection(
      liveContent,
      sha256(liveContent),
      saved,
      binaryPath,
    );

    expect(choosePatchBaseline(
      'patch',
      inspection(binaryPath, liveContent, liveInjection),
      inspection(backupPath, liveContent),
      saved,
      { binaryPath, backupPath, version: VERSION },
    )).toMatchObject({ ok: false, reason: expect.stringMatching(/injected/) });
  });
});

describe('transaction safety', () => {
  it('preserves live, backup, and manifest when staged patching fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-failed-patch-'));
    dirs.push(dir);
    const binaryPath = join(dir, 'claude');
    const backupPath = join(dir, 'claude.orig');
    const manifestPath = join(dir, 'patch-state.json');
    writeFileSync(binaryPath, BASELINE);
    writeFileSync(backupPath, 'stale same-version backup');
    const before = [readFileSync(binaryPath), readFileSync(backupPath)];

    const outcome = await applyPatchTransaction({
      binaryPath,
      backupPath,
      manifestPath,
      version: VERSION,
      desired: { config: CONFIG, unknownWindows: [] },
      configHash: 'new-config',
      manifest: null,
      trace: false,
    }, runtime(true));

    expect(outcome.ok).toBe(false);
    expect(readFileSync(binaryPath)).toEqual(before[0]);
    expect(readFileSync(backupPath)).toEqual(before[1]);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('restores only a positively injected live binary from its matching baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-safe-restore-'));
    dirs.push(dir);
    const binaryPath = join(dir, 'claude');
    const backupPath = join(dir, 'claude.orig');
    const manifestPath = join(dir, 'patch-state.json');
    const liveContent = `${BASELINE}\n${LEVERFRAME_INJECTION_MARKER}`;
    const saved = manifest(binaryPath, backupPath, liveContent, BASELINE);
    writeFileSync(binaryPath, liveContent);
    writeFileSync(backupPath, BASELINE);
    writeFileSync(manifestPath, JSON.stringify(saved));

    const restored = await restorePatchTransaction({
      binaryPath,
      backupPath,
      manifestPath,
      version: VERSION,
      manifest: saved,
    }, runtime());
    expect(restored.ok).toBe(true);
    expect(readFileSync(binaryPath, 'utf8')).toBe(BASELINE);
    expect(existsSync(manifestPath)).toBe(false);

    writeFileSync(binaryPath, `${BASELINE}\nnewer`);
    writeFileSync(manifestPath, JSON.stringify(saved));
    const unmarkedBefore = readFileSync(binaryPath);
    const refused = await restorePatchTransaction({
      binaryPath,
      backupPath,
      manifestPath,
      version: VERSION,
      manifest: saved,
    }, runtime());
    expect(refused.ok).toBe(false);
    expect(readFileSync(binaryPath)).toEqual(unmarkedBefore);
    expect(existsSync(manifestPath)).toBe(true);
  });
});

describe('injection recognition and patched state', () => {
  it('recognizes the versioned marker exactly once', () => {
    const out = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    expect(out.match(/\/\*leverframe:patch:[^*]*\*\//g)).toEqual([LEVERFRAME_INJECTION_MARKER]);
    expect(classifyLeverframeInjection(out, 'sha', null, '/claude')).toEqual({
      state: 'present',
      evidence: 'marker-v1',
    });
  });

  it('recognizes an exact manifest patched hash and the existing ccpatch marker', () => {
    const binaryPath = '/claude';
    const exact = manifest(binaryPath, '/backup', BASELINE, 'baseline');

    expect(classifyLeverframeInjection(BASELINE, exact.patchedSha256, exact, binaryPath)).toEqual({
      state: 'present',
      evidence: 'manifest-hash',
    });
    expect(classifyLeverframeInjection(`${BASELINE}\n/*ccpatch:ctx*/`, 'different', null, binaryPath)).toEqual({
      state: 'present',
      evidence: 'ccpatch',
    });
  });

  it('treats an unknown versioned marker as ambiguous', () => {
    expect(classifyLeverframeInjection(`${BASELINE}\n/*leverframe:patch:v999*/`, 'sha', null, '/claude')).toEqual({
      state: 'ambiguous',
      evidence: 'unknown-marker',
    });
    expect(classifyLeverframeInjection(
      `${BASELINE}\n${LEVERFRAME_INJECTION_MARKER}\n/*leverframe:patch:v999*/`,
      'sha',
      null,
      '/claude',
    )).toEqual({
      state: 'ambiguous',
      evidence: 'unknown-marker',
    });
  });

  it('detects a same-size patched hash mismatch', () => {
    const saved = manifest('/claude', '/backup', 'live', 'baseline');
    expect(evaluatePatchState(saved, {
      binaryPath: '/claude',
      claudeVersion: VERSION,
      configHash: saved.configHash,
      binarySize: saved.patchedSize,
      binarySha256: 'same-size-different-hash',
    })).toBe('stale-binary');
  });
});
