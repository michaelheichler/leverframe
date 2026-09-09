import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ commit: '' as '' | 'before' | 'after', removeManifest: false }));
vi.mock('../src/atomic-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/atomic-file.js')>();
  return {
    ...actual,
    commitSameDirectoryStageSync: (...args: Parameters<typeof actual.commitSameDirectoryStageSync>) => {
      if (faults.commit === 'before') throw new Error('synthetic pre-rename crash');
      actual.commitSameDirectoryStageSync(...args);
      if (faults.commit === 'after') throw new Error('synthetic post-rename crash');
    },
  };
});
vi.mock('../src/patch-state.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/patch-state.js')>();
  return {
    ...actual,
    removeManifestV2: (identity: string) => {
      if (faults.removeManifest) throw new Error('synthetic manifest cleanup failure');
      actual.removeManifestV2(identity);
    },
  };
});

import type { ClaudeInstallation } from '../src/claude-installation.js';
import { applyLeverframePatches } from '../src/patch-transforms.js';
import { addLeverframeInjectionMarker, classifyLeverframeInjectionByHash } from '../src/patch-injection.js';
import { applyPatchTransactionV2, getPatchJournalPath, readPatchJournal, restorePatchTransactionV2, type PatchRuntime } from '../src/patch-transaction.js';
import { checkResolvedPatchState, reconcilePatchTransaction, runPatchCommandV2 } from '../src/patch-reconcile.js';
import { getPatchManifestPathV2, readManifestV2 } from '../src/patch-state.js';
import { tryAcquirePatchTargetLock } from '../src/patch-lock.js';

const VERSION = '2.1.223';
const CONFIG = { 'leverframe:openai:model': { alias: 'model', context: 272_000 } };
const BASELINE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const runtime: PatchRuntime = {
  async inspect(path, knownHash) {
    const content = readFileSync(path, 'utf8');
    const sha256 = hash(content);
    return { path, readable: true, version: VERSION, sha256, injection: classifyLeverframeInjectionByHash(content, sha256, knownHash) };
  },
  async patch(path, config) {
    const patched = applyLeverframePatches(readFileSync(path, 'utf8'), config);
    writeFileSync(path, addLeverframeInjectionMarker(patched.content));
    return patched.results;
  },
  async readContent(path) { return readFileSync(path, 'utf8'); },
};
let home: string;
let previousHome: string | undefined;
let installation: ClaudeInstallation;
beforeEach(() => {
  previousHome = process.env['LEVERFRAME_HOME'];
  home = mkdtempSync(join(tmpdir(), 'leverframe-native-safety-'));
  process.env['LEVERFRAME_HOME'] = home;
  const path = join(home, 'synthetic-claude');
  writeFileSync(path, BASELINE, { mode: 0o700 });
  installation = { logicalPath: path, canonicalPath: path, installationPath: path, discoverySource: 'explicit-target', installationKind: 'custom', identity: hash(path), version: VERSION, executableType: 'binary' };
});
afterEach(() => {
  faults.commit = '';
  faults.removeManifest = false;
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});
const apply = (selectedRuntime = runtime) => applyPatchTransactionV2({ installation, desiredConfig: CONFIG, configHash: 'cfg', manifest: readManifestV2(installation.identity), trace: false }, selectedRuntime);

it('recovers a restore post-image from the older baseline-only journal phase', async () => {
  expect((await apply()).ok).toBe(true);
  faults.commit = 'after';
  await restorePatchTransactionV2({ installation, manifest: readManifestV2(installation.identity) }, runtime);
  faults.commit = '';
  const journal = readPatchJournal(installation.identity);
  if (!journal) throw new Error('fixture journal missing');
  journal.phase = 'baseline_committed';
  delete journal.patchedSha256;
  delete journal.patchedSize;
  writeFileSync(getPatchJournalPath(installation.identity), JSON.stringify(journal));
  expect((await reconcilePatchTransaction(installation, runtime)).action).toBe('completed');
  expect(readManifestV2(installation.identity)).toBeNull();
  expect(readPatchJournal(installation.identity)).toBeNull();
});

it.each(['content', 'identity'])('rejects destination %s drift while staging a patch', async kind => {
  const changed = kind === 'content' ? `${BASELINE}\ninstaller update` : BASELINE;
  const outcome = await apply({
    ...runtime,
    async patch(path, config) {
      const result = await runtime.patch(path, config);
      const replacement = join(home, 'installer-image');
      writeFileSync(replacement, changed);
      renameSync(replacement, installation.canonicalPath);
      return result;
    },
  });
  expect(outcome.ok).toBe(false);
  expect(outcome.message).toMatch(/changed|drift/i);
  expect(readFileSync(installation.canonicalPath, 'utf8')).toBe(changed);
  expect(readManifestV2(installation.identity)).toBeNull();
});

it('does not adopt baseline bytes changed after inspection', async () => {
  let first = true;
  const outcome = await apply({
    ...runtime,
    async inspect(path, knownHash) {
      const result = await runtime.inspect(path, knownHash);
      if (first) {
        first = false;
        writeFileSync(path, `${BASELINE}\nchanged after verification`);
      }
      return result;
    },
  });
  expect(outcome.ok).toBe(false);
  expect(readManifestV2(installation.identity)).toBeNull();
});

it.each(['before', 'after'] as const)('recovers restore interrupted %s binary publication', async phase => {
  expect((await apply()).ok).toBe(true);
  const manifest = readManifestV2(installation.identity);
  expect(manifest).not.toBeNull();
  const patched = readFileSync(installation.canonicalPath, 'utf8');
  faults.commit = phase;
  expect((await restorePatchTransactionV2({ installation, manifest }, runtime)).ok).toBe(false);
  faults.commit = '';
  const journal = readPatchJournal(installation.identity);
  expect(journal?.phase).toBe('binary_committed');
  expect(journal?.patchedSha256).toBe(hash(BASELINE));
  await reconcilePatchTransaction(installation, runtime);
  expect(readPatchJournal(installation.identity)).toBeNull();
  expect(readFileSync(installation.canonicalPath, 'utf8')).toBe(phase === 'after' ? BASELINE : patched);
  expect(readManifestV2(installation.identity)).toEqual(phase === 'after' ? null : manifest);
  expect((await reconcilePatchTransaction(installation, runtime)).action).toBe('none');
});

it('keeps restore recovery retryable when manifest cleanup fails', async () => {
  expect((await apply()).ok).toBe(true);
  faults.removeManifest = true;
  expect((await restorePatchTransactionV2({ installation, manifest: readManifestV2(installation.identity) }, runtime)).ok).toBe(false);
  await expect(reconcilePatchTransaction(installation, runtime)).rejects.toThrow('synthetic manifest cleanup failure');
  expect(readPatchJournal(installation.identity)?.phase).toBe('binary_committed');
  expect(readManifestV2(installation.identity)).not.toBeNull();
  faults.removeManifest = false;
  await reconcilePatchTransaction(installation, runtime);
  expect(readManifestV2(installation.identity)).toBeNull();
  expect(readPatchJournal(installation.identity)).toBeNull();
});

it.each(['reconcile', 'check', 'command'])('%s cannot inspect or discard a live owner journal', async entry => {
  faults.commit = 'before';
  expect((await apply()).ok).toBe(false);
  faults.commit = '';
  const journal = readPatchJournal(installation.identity);
  const lease = tryAcquirePatchTargetLock(installation.identity);
  if (!lease) throw new Error('fixture lock not acquired');
  const inspect = vi.fn(runtime.inspect);
  const observedRuntime = { ...runtime, inspect };
  const presenter = { error: vi.fn(), warn: vi.fn(), success: vi.fn(), detail: vi.fn(), notice: vi.fn(), confirm: async () => false };
  const pending = entry === 'reconcile'
    ? reconcilePatchTransaction(installation, observedRuntime)
    : entry === 'check'
      ? checkResolvedPatchState(installation, observedRuntime, [])
      : runPatchCommandV2({ installation, runtime: observedRuntime, freshProviders: [] }, presenter);
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(inspect).not.toHaveBeenCalled();
    expect(readPatchJournal(installation.identity)).toEqual(journal);
  } finally {
    lease.release();
    await pending;
  }
  expect(inspect).toHaveBeenCalled();
});

it.each(['target', 'baseline'])('rejects %s drift during restore staging', async kind => {
  expect((await apply()).ok).toBe(true);
  const manifest = readManifestV2(installation.identity);
  if (!manifest) throw new Error('fixture manifest missing');
  const patched = readFileSync(installation.canonicalPath, 'utf8');
  const outcome = await restorePatchTransactionV2({ installation, manifest }, {
    ...runtime,
    async inspect(path, knownHash) {
      const result = await runtime.inspect(path, knownHash);
      if (path !== installation.canonicalPath && path !== manifest.baselinePath) {
        writeFileSync(kind === 'target' ? installation.canonicalPath : manifest.baselinePath, 'changed by installer');
      }
      return result;
    },
  });
  expect(outcome.ok).toBe(false);
  expect(outcome.message).toMatch(/changed/);
  expect(readFileSync(installation.canonicalPath, 'utf8')).toBe(kind === 'target' ? 'changed by installer' : patched);
  expect(readManifestV2(installation.identity)).toEqual(manifest);
});

it('retains recovery metadata on an actual filesystem manifest removal error', async () => {
  expect((await apply()).ok).toBe(true);
  const manifest = readManifestV2(installation.identity);
  const manifestPath = getPatchManifestPathV2(installation.identity);
  rmSync(manifestPath);
  mkdirSync(manifestPath);
  expect((await restorePatchTransactionV2({ installation, manifest }, runtime)).ok).toBe(false);
  await expect(reconcilePatchTransaction(installation, runtime)).rejects.toThrow();
  expect(readPatchJournal(installation.identity)?.phase).toBe('binary_committed');
  expect(readFileSync(installation.canonicalPath, 'utf8')).toBe(BASELINE);
  rmSync(manifestPath, { recursive: true });
  expect((await reconcilePatchTransaction(installation, runtime)).action).toBe('completed');
  expect(readPatchJournal(installation.identity)).toBeNull();
});
