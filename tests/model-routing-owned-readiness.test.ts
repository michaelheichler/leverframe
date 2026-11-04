import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { buildDesiredPatchConfig, computePatchConfigHash } from '../src/patcher.js';
import { runLaunchPatchCheckV2 } from '../src/patch-reconcile.js';
import { removeManifestV2, currentTransformVersion, getPatchManifestPathV2, writeManifestV2 } from '../src/patch-state.js';
import { routingPreflight } from '../src/routing-policy-identity.js';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import type { PatchRuntime } from '../src/patch-transaction.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { sdkRoutingContext } from './fixtures/model-routing-proxy.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const routingContext = sdkRoutingContext();
const activeConfig = routingContext.config as RoutingConfig;
const activePreflight = routingPreflight(activeConfig, routingContext.catalog);
const activeOptions = { routingAvailable: true, routingConfig: activeConfig, routingPreflight: activePreflight };
const recoveryOptions = { routingRecoveryOnly: true } as unknown as NonNullable<Parameters<typeof buildDesiredPatchConfig>[2]>;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function installation(): ClaudeInstallation {
  const target = `${outerHome}/owned-routing-readiness`;
  return { logicalPath: target, canonicalPath: target, installationPath: target,
    discoverySource: 'explicit-target', installationKind: 'custom', identity: createHash('sha256').update(target).digest('hex'),
    version: '2.1.314', executableType: 'binary' };
}

function makeRuntime() {
  let readCount = 0;
  let writeCount = 0;
  const runtime: PatchRuntime = {
    async inspect(path) { return { path, readable: true, version: '2.1.314', sha256: 'f'.repeat(64),
      injection: { state: 'present', evidence: 'ccpatch' } }; },
    async patch() { writeCount += 1; return []; },
    async readContent() { readCount += 1; return 'A prior bundle without the required routing guard.'; },
  };
  return { runtime, reads: () => readCount, writes: () => writeCount };
}

it.each([
  { mode: 'active', desired: () => buildDesiredPatchConfig([], undefined, activeOptions), launch: () => ({
    routingAvailable: true, routingConfig: activeConfig, routingPreflight: activePreflight,
  }) },
  { mode: 'recovery-only', desired: () => buildDesiredPatchConfig([], undefined, recoveryOptions), launch: () => ({
    routingRecoveryOnly: true,
  }) },
])('rejects an owned matching-hash $mode bundle when its current routing guard is missing', async ({ desired, launch }) => {
  const target = installation();
  const manifestPath = getPatchManifestPathV2(target.identity);
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, manifestPath)).toBe(true);
  const config = desired();
  const runtime = makeRuntime();
  const patchHash = 'f'.repeat(64);
  writeManifestV2(target.identity, {
    schemaVersion: 2,
    transformVersion: currentTransformVersion(),
    generation: 1,
    logicalPath: target.installationPath,
    canonicalPath: target.canonicalPath,
    installationKind: 'custom',
    claudeVersion: target.version,
    baselineSha256: 'a'.repeat(64),
    baselinePath: `${outerHome}/verified-routing-baseline`,
    patchedSha256: patchHash,
    patchedSize: 32,
    semanticFingerprint: 'synthetic-owned-routing-fingerprint',
    configHash: computePatchConfigHash(config.config),
    provenance: 'live',
    completedAt: '2026-11-02T00:00:00.000Z',
  });

  try {
    await expect(runLaunchPatchCheckV2({ installation: target, runtime: runtime.runtime,
      freshProviders: [], agentStdout: true, ...launch() })).rejects.toThrow();

    expect(runtime.reads()).toBeGreaterThan(0);
    expect(runtime.writes()).toBe(0);
  } finally {
    expect(inside(outerHome!, manifestPath)).toBe(true);
    removeManifestV2(target.identity);
  }
});

it('keeps the owned matching-hash fast path when neither routing mode is active', async () => {
  const target = installation();
  const manifestPath = getPatchManifestPathV2(target.identity);
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, manifestPath)).toBe(true);
  const config = buildDesiredPatchConfig([], undefined, { includeContextModes: false });
  const runtime = makeRuntime();
  writeManifestV2(target.identity, {
    schemaVersion: 2,
    transformVersion: currentTransformVersion(),
    generation: 1,
    logicalPath: target.installationPath,
    canonicalPath: target.canonicalPath,
    installationKind: 'custom',
    claudeVersion: target.version,
    baselineSha256: 'a'.repeat(64),
    baselinePath: `${outerHome}/verified-legacy-baseline`,
    patchedSha256: 'f'.repeat(64),
    patchedSize: 32,
    semanticFingerprint: 'synthetic-owned-legacy-fingerprint',
    configHash: computePatchConfigHash(config.config),
    provenance: 'live',
    completedAt: '2026-11-02T00:00:00.000Z',
  });

  try {
    await runLaunchPatchCheckV2({ installation: target, runtime: runtime.runtime, agentStdout: true });

    expect(runtime.reads()).toBe(0);
    expect(runtime.writes()).toBe(0);
  } finally {
    expect(inside(outerHome!, manifestPath)).toBe(true);
    removeManifestV2(target.identity);
  }
});
