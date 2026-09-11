import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { savePreferences } from '../src/config.js';
import { resolveClaudeInstallation, type ClaudeInstallation } from '../src/claude-installation.js';
import { diagnosePatchV2 } from '../src/patch-diagnostics.js';
import { addLeverframeInjectionMarker, classifyLeverframeInjectionByHash } from '../src/patch-injection.js';
import { applyPatchTransactionV2, type PatchRuntime } from '../src/patch-transaction.js';
import { applyLeverframePatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import { buildDesiredPatchConfig } from '../src/patcher.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';

const VERSION = '2.1.223';
const BASELINE = [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then echo "2.1.223 (Claude Code)"; exit 0; fi',
  'exit 1',
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function runtime(): PatchRuntime {
  return {
    async inspect(path, knownPatchedSha256) {
      const content = readFileSync(path, 'utf8');
      const hash = sha256(content);
      return {
        path,
        readable: true,
        version: VERSION,
        sha256: hash,
        injection: classifyLeverframeInjectionByHash(content, hash, knownPatchedSha256),
      };
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
}

function seedRegistry(): void {
  const registry = loadRegistry();
  saveRegistry({
    ...registry,
    providers: [{
      id: 'openai',
      templateId: 'openai',
      name: 'OpenAI',
      enabled: true,
      authRef: 'test',
      api: {},
      modelsCache: {
        fetchedAt: '2026-09-07T00:00:00.000Z',
        models: [{
          id: 'model',
          name: 'Model',
          upstreamModelId: 'model',
          contextWindow: 272_000,
          modelFormat: 'anthropic',
        }],
      },
      addedAt: '2026-09-07T00:00:00.000Z',
    }],
  });
}

const homes: string[] = [];
const roots: string[] = [];
const previousHome = process.env['LEVERFRAME_HOME'];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});

async function prepareFixture(): Promise<{
  path: string;
  installation: ClaudeInstallation;
  applied: PatchScriptModelConfig;
}> {
  const root = mkdtempSync(join(tmpdir(), 'leverframe-diagnostics-'));
  roots.push(root);
  const home = join(root, 'home');
  homes.push(home);
  process.env['LEVERFRAME_HOME'] = home;
  const path = join(root, 'claude');
  writeFileSync(path, BASELINE, { mode: 0o755 });
  chmodSync(path, 0o755);
  seedRegistry();
  savePreferences({
    favoriteModels: [{ providerId: 'openai', modelId: 'model' }],
    modelAliases: [{ name: 'old', providerId: 'openai', modelId: 'model' }],
  });
  const installation = resolveClaudeInstallation({ target: path });
  if (!installation) throw new Error('fixture installation did not resolve');
  const applied = buildDesiredPatchConfig().config;
  const outcome = await applyPatchTransactionV2({
    installation,
    desiredConfig: applied,
    configHash: 'old-config',
    manifest: null,
    trace: false,
  }, runtime());
  if (!outcome.ok) throw new Error(outcome.message);
  savePreferences({
    favoriteModels: [{ providerId: 'openai', modelId: 'model' }],
    modelAliases: [{ name: 'new', providerId: 'openai', modelId: 'model' }],
  });
  return { path, installation, applied };
}

describe('patch diagnostics integration status', () => {
  it('reports incompatible native code when a required patch anchor is absent', async () => {
    const fixture = await prepareFixture();
    writeFileSync(fixture.path, BASELINE.replace(/function RS[^\n]+/, ''));

    const report = await diagnosePatchV2(fixture.path, runtime());

    expect(report.drift.injectionState).toBe('absent');
    expect(report.integration.capabilities).toContainEqual({
      status: 'FAIL',
      name: 'context-window',
      extra: 'anchor not found',
    });
    expect(report.integration.status).toBe('incompatible');
  });

  it('keeps an exact-hash installation integrated when only the desired cache is stale', async () => {
    const fixture = await prepareFixture();
    const report = await diagnosePatchV2(fixture.path, runtime());

    expect(report.drift.hashesMatch).toBe(true);
    expect(report.state).toBe('config_stale');
    expect(report.drift.semanticSitesComplete).toBeNull();
    expect(report.integration.status).toBe('integrated');
    expect(report.integration.capabilities).toContainEqual({
      status: 'OK',
      name: 'model-picker',
    });
  });

  it('reports unavailable integration when raw metadata is authenticated but source inspection fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'leverframe-diagnostics-unreadable-'));
    roots.push(root);
    const home = join(root, 'home');
    homes.push(home);
    process.env['LEVERFRAME_HOME'] = home;
    const path = join(root, 'claude');
    writeFileSync(path, BASELINE, { mode: 0o755 });
    chmodSync(path, 0o755);
    const hash = sha256(BASELINE);
    const unreadableRuntime: PatchRuntime = {
      ...runtime(),
      async inspect(target) {
        return {
          path: target,
          readable: false,
          version: VERSION,
          sha256: hash,
          injection: { state: 'absent', evidence: 'none' },
          error: 'Bun bytecode source unavailable',
        };
      },
    };

    const report = await diagnosePatchV2(path, unreadableRuntime);

    expect(report.state).toBe('unsupported');
    expect(report.integration.status).toBe('unavailable');
    expect(report.drift.injectionState).toBeNull();
    expect(report.nextAction).toMatch(/could not be inspected/i);
  });
});
