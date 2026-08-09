import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const commitStage = vi.hoisted(() => vi.fn());

vi.mock('../src/atomic-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/atomic-file.js')>();
  return { ...actual, commitSameDirectoryStageSync: commitStage };
});

import { applyLeverframePatches } from '../src/patch-transforms.js';
import { addLeverframeInjectionMarker, classifyLeverframeInjectionByHash } from '../src/patch-injection.js';
import { applyPatchTransactionV2, readPatchJournal, type PatchRuntime } from '../src/patch-transaction.js';
import type { ClaudeInstallation } from '../src/claude-installation.js';

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

function fixtureContent(payload = BASELINE): string {
  return [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "${VERSION} (Claude Code)"; exit 0; fi`,
    'exit 1',
    ": <<'LEVERFRAME_PAYLOAD'",
    payload,
    'LEVERFRAME_PAYLOAD',
  ].join('\n');
}

const runtime: PatchRuntime = {
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
      return { path, readable: false, version: null, sha256: null, injection: { state: 'ambiguous', evidence: 'unknown-marker' } };
    }
  },
  async patch(path, config) {
    const patched = applyLeverframePatches(readFileSync(path, 'utf8'), config);
    writeFileSync(path, addLeverframeInjectionMarker(patched.content));
    return patched.results;
  },
  async readContent(path) {
    return readFileSync(path, 'utf8');
  },
};

const homes: string[] = [];
const workDirs: string[] = [];
let previousHome: string | undefined;

afterEach(() => {
  commitStage.mockReset();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const path of workDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});

it('persists the staged post-image in the journal before the binary rename', async () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-transaction-home-'));
  const workDir = mkdtempSync(join(tmpdir(), 'leverframe-transaction-work-'));
  homes.push(home);
  workDirs.push(workDir);
  previousHome = process.env['LEVERFRAME_HOME'];
  process.env['LEVERFRAME_HOME'] = home;

  const canonicalPath = join(workDir, 'claude');
  const baseline = fixtureContent();
  writeFileSync(canonicalPath, baseline, { mode: 0o755 });
  chmodSync(canonicalPath, 0o755);
  const installation: ClaudeInstallation = {
    logicalPath: canonicalPath,
    canonicalPath,
    installationPath: canonicalPath,
    discoverySource: 'explicit-target',
    installationKind: 'custom',
    identity: sha256(canonicalPath),
    version: VERSION,
    executableType: 'binary',
  };
  const checkpoint: { journal: ReturnType<typeof readPatchJournal> } = { journal: null };
  let stagedHash: string | undefined;
  let stagedSize: number | undefined;
  commitStage.mockImplementation(stagePath => {
    checkpoint.journal = readPatchJournal(installation.identity);
    stagedHash = sha256(readFileSync(stagePath, 'utf8'));
    stagedSize = statSync(stagePath).size;
    throw new Error('synthetic stop at binary rename');
  });

  const outcome = await applyPatchTransactionV2(
    { installation, desiredConfig: CONFIG, configHash: 'cfg', manifest: null, trace: false },
    runtime,
  );

  expect(outcome.ok).toBe(false);
  expect(readFileSync(canonicalPath, 'utf8')).toBe(baseline);
  expect(checkpoint.journal?.phase).toBe('binary_committed');
  expect(checkpoint.journal?.patchedSha256).toBe(stagedHash);
  expect(checkpoint.journal?.patchedSize).toBe(stagedSize);
});
