import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { savePreferences } from '../src/config.js';
import { getConfigPath, getAppHome } from '../src/paths.js';
import { buildDesiredPatchConfig, computePatchConfigHash } from '../src/patcher.js';
import { checkResolvedPatchState } from '../src/patch-reconcile.js';
import { applyLeverframePatches } from '../src/patch-transforms.js';
import { verifyPatchSites } from '../src/patch-transaction.js';
import { CLAUDE_MODULE_BOUNDARY, splitModulePayload } from '../src/claude-bundle-native.js';
import { currentTransformVersion, getPatchManifestPathV2, removeManifestV2, writeManifestV2 } from '../src/patch-state.js';
import {
  CLAUDE_AGENT_2_1_314_ROUTING_DECISION_SOURCE,
  CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE,
  CLAUDE_AGENT_2_1_314_ROUTING_SIDECAR_SOURCE,
  CLAUDE_AGENT_2_1_314_ROUTING_SOURCE,
} from './fixtures/claude-agent-2.1.314-routing.js';
import { claudeAgentRoutingNoticeCompositionSource } from './fixtures/claude-agent-2.1.314-routing-composition.js';
import { routingTransportFingerprint } from '../src/routing-transport-identity.js';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import type { PatchRuntime } from '../src/patch-transaction.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const routingOptions = { routingAvailable: true };
const routingEnabledPreferences = {
  enabled: true,
  cheapFallback: { providerId: 'fixture-patch-provider', modelId: 'fixture-patch-model' },
  pool: [{ providerId: 'fixture-patch-provider', modelId: 'fixture-patch-model' }],
};
const routerPolicyModelId = 'leverframe:fixture-patch-provider:fixture-patch-model';
const routerMetadata = { contextWindow: 88_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low', 'medium'] };
const routingPreflight = {
  target: routingEnabledPreferences.cheapFallback,
  policyModelId: routerPolicyModelId,
  contextWindow: 88_000,
  metadata: routerMetadata,
  targetMetadata: { [routerPolicyModelId]: routerMetadata },
  identity: { upstreamModelId: 'fixture-patch-upstream-model', credentialSource: 'registry' as const,
    transportFingerprint: routingTransportFingerprint({ endpoint: 'https://patch-fixture.invalid/v1',
      npm: '@ai-sdk/openai-compatible', format: 'openai', credentialSource: 'registry' })! },
  accountIds: [],
};

function assertConfigWriteIsIsolated(): void {
  expect(outerHome).toBeTruthy();
  const configPath = getConfigPath();
  expect(configPath.startsWith(getAppHome())).toBe(true);
  expect(configPath.startsWith(outerHome!)).toBe(true);
}

it('adds the automatic picker entry only when saved routing is enabled and the harness is available', () => {
  try {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: routingEnabledPreferences });

    const unavailable = buildDesiredPatchConfig([]);
    const desired = buildDesiredPatchConfig([], undefined, { ...routingOptions, routingPreflight });

    expect(Object.keys(desired.config)).toEqual(['auto']);
    expect(desired.config['auto']).toMatchObject({
      routingEnabled: true,
      routingPolicyModelId: routingPreflight.policyModelId,
      routingMetadata: routingPreflight.metadata,
    });
    expect(computePatchConfigHash(desired.config)).not.toBe(computePatchConfigHash(unavailable.config));
  } finally {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: { enabled: false } });
  }
});

it('keeps the automatic picker entry inactive when routing is unavailable to the harness', () => {
  try {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: routingEnabledPreferences });

    const desired = buildDesiredPatchConfig([]);

    expect(desired.config['auto']).toBeUndefined();
  } finally {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: { enabled: false } });
  }
});

it('refuses to activate a routing picker entry without a frozen preflight', () => {
  try {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: routingEnabledPreferences });

    expect(() => buildDesiredPatchConfig([], undefined, routingOptions)).toThrow();
  } finally {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: { enabled: false } });
  }
});

it.each([
  { label: 'context window', preflight: { ...routingPreflight, contextWindow: undefined,
    metadata: { ...routingPreflight.metadata, contextWindow: undefined },
    targetMetadata: { ...routingPreflight.targetMetadata,
      [routerPolicyModelId]: { ...routerMetadata, contextWindow: undefined } } } },
  { label: 'output limit', preflight: { ...routingPreflight,
    metadata: { ...routingPreflight.metadata, maxOutputTokens: undefined },
    targetMetadata: { ...routingPreflight.targetMetadata,
      [routerPolicyModelId]: { ...routingPreflight.targetMetadata[routerPolicyModelId], maxOutputTokens: undefined } } } },
])('keeps the active patch source unchanged when its confirmed $label is unknown', ({ preflight }) => {
  const source = [CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE,
    CLAUDE_AGENT_2_1_314_ROUTING_SOURCE, CLAUDE_AGENT_2_1_314_ROUTING_DECISION_SOURCE,
    CLAUDE_AGENT_2_1_314_ROUTING_SIDECAR_SOURCE].join('\n');
  const outcome = applyLeverframePatches(source, { auto: {
    routingEnabled: true,
    routingPolicyModelId: preflight.policyModelId,
    routingMetadata: preflight.metadata,
    routingTargetMetadata: preflight.targetMetadata,
  } });

  expect(outcome.content).toBe(source);
  expect(outcome.results.some(site => site.status === 'FAIL')).toBe(true);
});

it('keeps ordinary provider choices when routing preferences are off', () => {
  try {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: { enabled: false } });
    const freshProviders = [{
      id: 'fixture-patch-provider', name: 'Fixture Provider', apiKey: 'fixture-key', models: [{
        id: 'fixture-patch-model', name: 'Fixture Model', family: 'fixture', brand: 'fixture',
        modelFormat: 'openai' as const, upstreamModelId: 'fixture-upstream-model',
      }],
    }];

    const desired = buildDesiredPatchConfig(freshProviders, undefined, { ...routingOptions, routingPreflight });
    const ordinary = buildDesiredPatchConfig(freshProviders);

    expect(Object.keys(desired.config)).toEqual(['leverframe:fixture-patch-provider:fixture-patch-model']);
    expect(desired.config['auto']).toBeUndefined();
    expect(computePatchConfigHash(desired.config)).toBe(computePatchConfigHash(ordinary.config));
  } finally {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: { enabled: false } });
  }
});

it.each([
  { label: 'pin', changed: { ...routingPreflight, policyModelId: 'another-confirmed-policy-model' } },
  { label: 'confirmed metadata', changed: { ...routingPreflight, metadata: { ...routingPreflight.metadata, contextWindow: 72_000 } } },
])('changes the active routing patch hash when its confirmed $label changes', ({ changed }) => {
  try {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: routingEnabledPreferences });
    const baseline = buildDesiredPatchConfig([], undefined, { ...routingOptions, routingPreflight });
    const updated = buildDesiredPatchConfig([], undefined, { ...routingOptions, routingPreflight: changed });

    expect(computePatchConfigHash(updated.config)).not.toBe(computePatchConfigHash(baseline.config));
  } finally {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: { enabled: false } });
  }
});

it('includes the routing entry in patch readiness when the shared runtime is available', async () => {
  try {
    assertConfigWriteIsIsolated();
    const startupRouting = { ...routingEnabledPreferences, visibleModelId: 'ready-session-router' };
    savePreferences({ routing: startupRouting });
    savePreferences({ routing: { ...routingEnabledPreferences, visibleModelId: 'changed-session-router' } });
    const targetPath = `${outerHome}/claude-fixture`;
    const installation: ClaudeInstallation = {
      logicalPath: targetPath,
      canonicalPath: targetPath,
      installationPath: targetPath,
      discoverySource: 'explicit-target',
      installationKind: 'custom',
      identity: createHash('sha256').update(targetPath).digest('hex'),
      version: '2.1.314',
      executableType: 'binary',
    };
    const runtime: PatchRuntime = {
      async inspect(path) {
        return { path, readable: false, version: null, sha256: null, injection: { state: 'ambiguous', evidence: 'unknown-marker' } };
      },
      async patch() { throw new Error('patch should not run during readiness inspection'); },
      async readContent() { throw new Error('content should not be read for an unreadable fixture'); },
    };

    const readiness = await checkResolvedPatchState(installation, runtime, [], undefined, true, true, startupRouting, routingPreflight);
    const unavailable = buildDesiredPatchConfig([]);

    expect(readiness.desired.config['ready-session-router']).toMatchObject({
      routingEnabled: true,
      routingPolicyModelId: routingPreflight.policyModelId,
      routingMetadata: routingPreflight.metadata,
    });
    expect(readiness.desired.config['changed-session-router']).toBeUndefined();
    expect(readiness.configHash).not.toBe(computePatchConfigHash(unavailable.config));
  } finally {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: { enabled: false } });
  }
});

it('readiness semantically validates the double-applied source with its frozen target metadata map', async () => {
  assertConfigWriteIsIsolated();
  const installationPath = `${outerHome}/claude-routing-readiness-fixture`;
  const installation: ClaudeInstallation = {
    logicalPath: installationPath,
    canonicalPath: installationPath,
    installationPath,
    discoverySource: 'explicit-target',
    installationKind: 'custom',
    identity: createHash('sha256').update(installationPath).digest('hex'),
    version: '2.1.314',
    executableType: 'binary',
  };
  const shell = `function patcherShell(){
const schema=z.enum(["sonnet","opus","haiku","fable"]).optional().describe(\`Optional model override for this agent.\`);
var KNOWN=["sonnet","opus","haiku","fable","opusplan"];
function alias(x){switch(x){case"best":{return"opus"}default:return null}}
function options(e,t,r){let n=current(),o=n==="opus"?[n,r]:[r];for(let i of o)apply(e,i,t);return e}
function capabilities(e,t){let r=feature();if(r!==void 0)return r;if(allowed(e,t))return supported;return unavailable}
function defaultEffort(e){return metadata(e)?.default_effort??"high"}
}`;
  const sourceModules = splitModulePayload(claudeAgentRoutingNoticeCompositionSource());
  expect(sourceModules).not.toBeNull();
  const adapterModule = sourceModules!.find(([name]) => name === '/$bunfs/root/chunk-f5200rjz.js')!;
  adapterModule[1] = `${shell}\n${adapterModule[1]}`;
  const source = sourceModules!.map(([name, content]) => `${CLAUDE_MODULE_BOUNDARY}${name}\n${content}`).join('');
  const desired = buildDesiredPatchConfig([], undefined, { ...routingOptions,
    routingConfig: routingEnabledPreferences, routingPreflight });
  const patched = applyLeverframePatches(source, desired.config);
  const semantic = verifyPatchSites(patched.content, desired.config);
  const manifestPath = getPatchManifestPathV2(installation.identity);
  const liveHash = 'c'.repeat(64);
  const manifestHash = 'b'.repeat(64);
  expect(manifestPath.startsWith(outerHome!)).toBe(true);
  const contentReads: string[] = [];
  const runtime: PatchRuntime = {
    async inspect(path) {
      return { path, readable: true, version: '2.1.314', sha256: liveHash,
        injection: { state: 'present', evidence: 'ccpatch' } };
    },
    async patch() { throw new Error('readiness must not write the patch'); },
    async readContent(path) { contentReads.push(path); return patched.content; },
  };

  try {
    expect(manifestPath.startsWith(outerHome!)).toBe(true);
    writeManifestV2(installation.identity, {
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation: 1,
      logicalPath: installationPath,
      canonicalPath: installationPath,
      installationKind: 'custom',
      claudeVersion: '2.1.314',
      baselineSha256: 'a'.repeat(64),
      baselinePath: `${outerHome}/claude-routing-readiness-baseline`,
      patchedSha256: manifestHash,
      patchedSize: patched.content.length,
      semanticFingerprint: 'fixture-fingerprint',
      configHash: 'fixture-config-hash',
      provenance: 'live',
      completedAt: '2026-11-02T00:00:00.000Z',
    });
    const readiness = await checkResolvedPatchState(installation, runtime, [], undefined, true, true,
      routingEnabledPreferences, routingPreflight);

    expect(readiness.state, JSON.stringify(semantic.results)).toBe('modified_but_injected');
    expect(semantic.complete).toBe(true);
    expect(contentReads).toEqual([installationPath]);
    expect(readiness.desired.config['auto']?.routingTargetMetadata).toEqual(routingPreflight.targetMetadata);
    expect(patched.content).toBe(applyLeverframePatches(patched.content, desired.config).content);
  } finally {
    assertConfigWriteIsIsolated();
    removeManifestV2(installation.identity);
  }
});

it('keeps the startup routing identity after saved preferences change', () => {
  try {
    assertConfigWriteIsIsolated();
    const startupRouting = { ...routingEnabledPreferences, visibleModelId: 'session-router' };
    savePreferences({ routing: startupRouting });
    const startupConfig = buildDesiredPatchConfig([], undefined, {
      routingAvailable: true,
      routingConfig: startupRouting,
      routingPreflight,
    });
    savePreferences({ routing: { ...routingEnabledPreferences, visibleModelId: 'next-session-router' } });

    const activeSessionConfig = buildDesiredPatchConfig([], undefined, {
      routingAvailable: true,
      routingConfig: startupRouting,
      routingPreflight,
    });

    expect(activeSessionConfig.config).toEqual(startupConfig.config);
    expect(computePatchConfigHash(activeSessionConfig.config)).toBe(computePatchConfigHash(startupConfig.config));
  } finally {
    assertConfigWriteIsIsolated();
    savePreferences({ routing: { enabled: false } });
  }
});
