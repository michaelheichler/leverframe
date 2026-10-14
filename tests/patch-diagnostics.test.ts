import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { savePreferences } from '../src/config.js';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { resolveClaudeInstallation, type ClaudeInstallation } from '../src/claude-installation.js';
import { diagnosePatchV2, formatPatchDiagnosticsText } from '../src/patch-diagnostics.js';
import { addLeverframeInjectionMarker, classifyLeverframeInjectionByHash } from '../src/patch-injection.js';
import type { PatchPresenter } from '../src/patch-presenter.js';
import { runLaunchPatchCheckV2, runPatchCommandV2 } from '../src/patch-reconcile.js';
import { readManifestV2 } from '../src/patch-state.js';
import { applyPatchTransactionV2, type PatchRuntime } from '../src/patch-transaction.js';
import { fetchProviderCatalog } from '../src/provider-catalog.js';
import type { FavoriteModel } from '../src/types.js';
import { applyLeverframePatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import { buildDesiredPatchConfig } from '../src/patcher.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import type { CachedModel } from '../src/registry/types.js';

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

function catalogModel(id: string): CachedModel {
  return { id, name: id, upstreamModelId: id, contextWindow: 272_000, modelFormat: 'openai' };
}

function unreadableRuntime(): PatchRuntime {
  return {
    ...runtime(),
    async inspect(target) {
      return {
        path: target,
        readable: false,
        version: VERSION,
        sha256: sha256(BASELINE),
        injection: { state: 'absent', evidence: 'none' },
        error: 'Bun bytecode source unavailable',
      };
    },
  };
}

function seedRegistry(models: CachedModel[], authRef = 'env:LEVERFRAME_TEST_CATALOG_KEY'): void {
  vi.stubEnv('LEVERFRAME_TEST_CATALOG_KEY', 'catalog-key');
  saveRegistry({
    ...loadRegistry(),
    providers: [{
      id: 'openai',
      templateId: 'openai',
      name: 'OpenAI',
      enabled: true,
      authRef,
      api: { npm: '@ai-sdk/openai' },
      modelsCache: { fetchedAt: '2026-10-14T00:00:00.000Z', models },
      addedAt: '2026-10-14T00:00:00.000Z',
    }],
  });
}

const homes: string[] = [];
const roots: string[] = [];
const previousHome = process.env['LEVERFRAME_HOME'];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});

function prepareTarget(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const home = join(root, 'home');
  homes.push(home);
  process.env['LEVERFRAME_HOME'] = home;
  const path = join(root, 'claude');
  writeFileSync(path, BASELINE, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function resolveFixtureInstallation(path: string): ClaudeInstallation {
  const installation = resolveClaudeInstallation({ target: path });
  if (!installation) throw new Error('fixture installation did not resolve');
  return installation;
}

async function prepareFixture(): Promise<{
  path: string;
  installation: ClaudeInstallation;
  applied: PatchScriptModelConfig;
}> {
  const path = prepareTarget('leverframe-diagnostics-');
  seedRegistry([catalogModel('model')]);
  savePreferences({
    favoriteModels: [{ providerId: 'openai', modelId: 'model' }],
    modelAliases: [{ name: 'old', providerId: 'openai', modelId: 'model' }],
  });
  const installation = resolveFixtureInstallation(path);
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

const silentPresenter: PatchPresenter = {
  error() {},
  warn() {},
  success() {},
  detail() {},
  notice() {},
  async confirm() { return false; },
};

function prepareCatalogFixture(): { path: string; installation: ClaudeInstallation } {
  const path = prepareTarget('leverframe-diagnostics-catalog-');
  seedRegistry([catalogModel('favorite'), catalogModel('selected'), catalogModel('other')]);
  savePreferences({
    favoriteModels: [{ providerId: 'openai', modelId: 'favorite' }],
    modelAliases: [{ name: 'fav', providerId: 'openai', modelId: 'favorite' }],
  });
  return { path, installation: resolveFixtureInstallation(path) };
}

async function launchPatch(installation: ClaudeInstallation, selectedModel?: FavoriteModel): Promise<void> {
  await runLaunchPatchCheckV2({
    agentStdout: true,
    installation,
    runtime: runtime(),
    freshProviders: await fetchProviderCatalog({ agent: 'claude' }),
    selectedModel,
  }, silentPresenter);
}

function cliPatch(installation: ClaudeInstallation): Promise<number> {
  return runPatchCommandV2({ installation, runtime: runtime() }, silentPresenter);
}

const OAUTH_ACCOUNT = 'oauth:provider:openai';

function stubExpiredOAuthKeyring(): string[] {
  const expired = JSON.stringify({ type: 'oauth', access: 'expired-dummy', refresh: 'refresh-dummy', expires: 0 });
  const operations: string[] = [];
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    operations.push(input.operation);
    const stored = input.operation === 'peek' && input.service === 'leverframe' && input.account === OAUTH_ACCOUNT;
    return { ok: true, value: stored ? expired : null };
  });
  return operations;
}

describe('patch diagnostics after a fresh patch', () => {
  it('reads an expired OAuth credential without refreshing or rewriting it', async () => {
    const path = prepareTarget('leverframe-diagnostics-oauth-');
    seedRegistry([catalogModel('favorite')], `keyring:${OAUTH_ACCOUNT}`);
    savePreferences({ favoriteModels: [{ providerId: 'openai', modelId: 'favorite' }] });
    const operations = stubExpiredOAuthKeyring();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled'));
    const exitCode = await cliPatch(resolveFixtureInstallation(path));

    const report = await diagnosePatchV2(path, runtime());

    expect(exitCode).toBe(0);
    expect(report.state).toBe('patched');
    expect(report.catalog).toEqual({ source: 'cache', refreshDue: ['openai'] });
    expect(formatPatchDiagnosticsText(report)).toContainEqual(expect.stringMatching(/refreshes credentials for openai$/));
    expect(network).not.toHaveBeenCalled();
    expect(new Set(operations)).toEqual(new Set(['peek']));
  });

  it('reports the patch current right after a launch patched every catalog model', async () => {
    const fixture = prepareCatalogFixture();
    await launchPatch(fixture.installation);

    const report = await diagnosePatchV2(fixture.path, runtime());

    expect(report.manifest.present).toBe(true);
    expect(report.state).toBe('patched');
  });

  it('reports the patch current right after leverframe patch', async () => {
    const fixture = prepareCatalogFixture();
    const exitCode = await cliPatch(fixture.installation);

    const report = await diagnosePatchV2(fixture.path, runtime());

    expect(exitCode).toBe(0);
    expect(report.state).toBe('patched');
    expect(report.catalog).toEqual({ source: 'cache', refreshDue: [] });
  });

  it('keeps a launch with a selected model current when leverframe patch runs afterwards', async () => {
    const fixture = prepareCatalogFixture();
    await launchPatch(fixture.installation, { providerId: 'openai', modelId: 'selected' });
    const generation = readManifestV2(fixture.installation.identity)?.generation;

    const exitCode = await cliPatch(fixture.installation);

    expect(exitCode).toBe(0);
    expect(readManifestV2(fixture.installation.identity)?.generation).toBe(generation);
  });
});

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
    const path = prepareTarget('leverframe-diagnostics-unreadable-');

    const report = await diagnosePatchV2(path, unreadableRuntime());

    expect(report.state).toBe('unsupported');
    expect(report.integration.status).toBe('unavailable');
    expect(report.drift.injectionState).toBeNull();
    expect(report.nextAction).toMatch(/could not be inspected/i);
  });
});
