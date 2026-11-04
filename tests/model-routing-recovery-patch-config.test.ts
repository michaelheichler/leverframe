import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { buildDesiredPatchConfig, computePatchConfigHash } from '../src/patcher.js';
import { CLAUDE_MODULE_BOUNDARY, splitModulePayload } from '../src/claude-bundle-native.js';
import { applyLeverframePatches, ROUTING_RECOVERY_ENTRY } from '../src/patch-transforms.js';
import { checkResolvedPatchState } from '../src/patch-reconcile.js';
import { runLaunchPatchCheckV2 } from '../src/patch-reconcile.js';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import type { PatchRuntime } from '../src/patch-transaction.js';
import type { PatchPresenter } from '../src/patch-presenter.js';
import type { LocalProvider } from '../src/types.js';
import { getAppHome } from '../src/paths.js';
import { CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE } from './fixtures/claude-agent-2.1.314-recovery.js';
import { noticeFrameSource } from './fixtures/claude-agent-2.1.314-notice-frame.js';
import { noticeHostSource, noticeRequestSource } from './fixtures/claude-agent-2.1.314-notice-host.js';
import { auxiliaryGuardSource, auxiliaryRequestSource } from './fixtures/claude-agent-2.1.314-notice-auxiliary-guard.js';
import { noticeStartupSource } from './fixtures/claude-agent-2.1.314-notice-startup.js';
import { noticeWriterSource } from './fixtures/claude-agent-2.1.314-notice-writer.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const recoveryOptions = { routingRecoveryOnly: true, includeContextModes: false } as unknown as NonNullable<Parameters<typeof buildDesiredPatchConfig>[2]>;
const patcherShell = [
  'function patcherShell(){',
  'const schema=z.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`);',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function alias(x){switch(x){case"best":{return"opus"}default:return null}}',
  'function options(e,t,r){let n=current(),o=n==="opus"?[n,r]:[r];for(let i of o)apply(e,i,t);return e}',
  'function capabilities(e,t){let r=feature();if(r!==void 0)return r;if(allowed(e,t))return supported;return unavailable}',
  'function defaultEffort(e){return metadata(e)?.default_effort??"high"}',
  '}',
].join('\n');

function recoverySource(): string {
  const writerModule = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-w2wf6pm6.js\n${noticeWriterSource}`;
  const adapterModule = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-f5200rjz.js\nfunction ai(){return{get(){}}}export{ai};`;
  const modules = new Map<string, string>();
  for (const fragment of [CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE, writerModule, noticeFrameSource,
    noticeStartupSource, noticeHostSource + noticeRequestSource, auxiliaryGuardSource + auxiliaryRequestSource, adapterModule]) {
    const parsed = splitModulePayload(fragment);
    if (!parsed) throw new Error('A bounded routing fixture has no module boundary.');
    for (const [name, content] of parsed) {
      const previous = modules.get(name);
      modules.set(name, previous === undefined ? content : `${previous}\n${content}`);
    }
  }
  const source = [...modules].map(([name, content]) => `${CLAUDE_MODULE_BOUNDARY}${name}\n${content}`).join('');
  return [patcherShell, source].join('\n');
}

function assertFixtureHome(): void {
  expect(outerHome).toBeTruthy();
  if (!outerHome) throw new Error('LEVERFRAME_TEST_HOME must be set before test imports.');
  expect(getAppHome().startsWith(outerHome)).toBe(true);
}

function ordinaryProviders(): LocalProvider[] {
  return [{ id: 'fixture-recovery-provider', name: 'Fixture recovery provider', apiKey: 'dummy-provider-key',
    models: [{ id: 'fixture-recovery-model', name: 'Fixture recovery model', family: 'fixture', brand: 'fixture',
      modelFormat: 'openai', upstreamModelId: 'fixture-recovery-upstream',
      apiBaseUrl: 'http://127.0.0.1:43123/v1', npm: '@ai-sdk/openai-compatible' }] }];
}

function recoveryConfig(providers = ordinaryProviders()) {
  return buildDesiredPatchConfig(providers, undefined, recoveryOptions).config;
}

function nativeModelIsAllowed(source: string): boolean {
  const moduleStart = source.indexOf(CLAUDE_MODULE_BOUNDARY);
  const modules = moduleStart < 0 ? undefined : splitModulePayload(source.slice(moduleStart));
  const recoveryModule = modules?.find(([name]) => name === '/$bunfs/root/chunk-bqbyxpv1.js');
  if (!recoveryModule) throw new Error('The bounded recovery module is missing.');
  const executable = recoveryModule[1]
    .replace('import{AsyncLocalStorage as __lfRecoveryALS}from"node:async_hooks";', 'const __lfRecoveryALS=AsyncLocalStorage;')
    .replace(/import\{[^}]+\}from"[^"]+";/g, '')
    .replace(/export\{__lfRecoveryRun,__lfRecoveryCurrent,__lfRecoveryIterator,__lfRecoveryBounds\};/g, '');
  return runInNewContext(executable + '\n;ro("fixture-native-model",{allowlist:["fixture-native-model"]})', {
    AsyncLocalStorage,
    gOe: () => false,
    e3: () => false,
    uV: () => false,
    lr: () => ({ availableModels: ['fixture-native-model'] }),
    wK: () => false,
    Qdt: () => ({ kind: 'normal' }),
    Dt: (model: string) => model.toLowerCase(),
    v_: () => false,
    dr: () => false,
    beo: () => false,
    Xy: () => undefined,
    ln: () => ({}),
  }) as boolean;
}

function installation(): ClaudeInstallation {
  const target = `${outerHome}/recovery-readiness-fixture`;
  return { logicalPath: target, canonicalPath: target, installationPath: target,
    discoverySource: 'explicit-target', installationKind: 'custom', identity: createHash('sha256').update(target).digest('hex'),
    version: '2.1.314', executableType: 'binary' };
}

function unreadableRuntime(): PatchRuntime {
  return {
    async inspect(path) {
      return { path, readable: false, version: null, sha256: null,
        injection: { state: 'ambiguous', evidence: 'unknown-marker' } };
    },
    async patch() { throw new Error('readiness must not patch an unreadable fixture'); },
    async readContent() { throw new Error('readiness must not read an unreadable fixture'); },
  };
}

it('keeps a fresh disabled hash stable while recovery-only changes the patch hash without adding a picker entry', () => {
  assertFixtureHome();
  const providers = ordinaryProviders();
  const offOptions = { includeContextModes: false };
  const firstOff = buildDesiredPatchConfig(providers, undefined, offOptions);
  const secondOff = buildDesiredPatchConfig(providers, undefined, offOptions);
  const recovery = buildDesiredPatchConfig(providers, undefined, recoveryOptions);

  expect(recovery.config['auto']).toBeUndefined();
  expect(recovery.config).toMatchObject(firstOff.config);
  expect(recovery.config[ROUTING_RECOVERY_ENTRY]).toMatchObject({ routingRecoveryOnly: true });
  expect(Object.keys(recovery.config)).toHaveLength(Object.keys(firstOff.config).length + 1);
  expect(computePatchConfigHash(firstOff.config)).toBe(computePatchConfigHash(secondOff.config));
  expect(computePatchConfigHash(firstOff.config)).toBe('106e5d78ff2c955ba14595fc327030d9de37820159877279a6f2a7f1dab062c0');
  expect(computePatchConfigHash(recovery.config)).not.toBe(computePatchConfigHash(firstOff.config));
});

it('applies recovery hooks without changing ordinary native model availability', () => {
  assertFixtureHome();
  const config = recoveryConfig();
  const ordinaryConfig = buildDesiredPatchConfig(ordinaryProviders(), undefined, { includeContextModes: false }).config;
  const source = recoverySource();
  const before = nativeModelIsAllowed(source);
  const patched = applyLeverframePatches(source, config);

  expect(patched.results.some(item => item.status === 'FAIL')).toBe(false);
  expect(patched.content).not.toBe(source);
  expect(config).toMatchObject(ordinaryConfig);
  expect(nativeModelIsAllowed(patched.content)).toBe(before);
  expect(config['auto']).toBeUndefined();
});

it('keeps recovery-only patch application unchanged when the supported source is incomplete', () => {
  assertFixtureHome();
  const source = recoverySource();
  const unsupported = source.replace('async function Xo(', 'async function unsupportedXo(');
  const outcome = applyLeverframePatches(unsupported, recoveryConfig(ordinaryProviders()));

  expect(outcome.content).toBe(unsupported);
  expect(outcome.results.some(item => item.status === 'FAIL')).toBe(true);
});

it('reapplies the same recovery-only patch without changing the transformed bundle', () => {
  assertFixtureHome();
  const source = recoverySource();
  const config = recoveryConfig(ordinaryProviders());
  const first = applyLeverframePatches(source, config);
  const second = applyLeverframePatches(first.content, config);

  expect(first.results.some(item => item.status === 'FAIL')).toBe(false);
  expect(second.results.some(item => item.status === 'FAIL')).toBe(false);
  expect(first.content).not.toBe(source);
  expect(second.content).toBe(first.content);
});

it('rejects a configuration that combines recovery hooks with an active router entry', () => {
  const config = { [ROUTING_RECOVERY_ENTRY]: { routingRecoveryOnly: true as const },
    auto: { routingEnabled: true as const, routingPolicyModelId: 'fixture-router-policy' } };

  expect(() => applyLeverframePatches('', config)).toThrow();
});

it('rejects visible model metadata stored under the internal recovery entry', () => {
  const config = { ...recoveryConfig(), [ROUTING_RECOVERY_ENTRY]: {
    routingRecoveryOnly: true as const, display: 'Fixture model',
  } };
  const source = recoverySource();

  expect(() => applyLeverframePatches(source, config)).toThrow();
});

it('carries recovery-only mode into the desired patch during readiness', async () => {
  assertFixtureHome();
  const recoveryCheck = checkResolvedPatchState as unknown as (...args: unknown[]) => Promise<{
    desired: { config: Record<string, unknown> };
    configHash: string;
  }>;
  const readiness = await recoveryCheck(installation(), unreadableRuntime(), [], undefined, true, false,
    undefined, undefined, true);
  expect(readiness.desired.config['auto']).toBeUndefined();
  expect(Object.keys(readiness.desired.config).length).toBeGreaterThan(0);
  expect(readiness.configHash).not.toBe('75f19acf6456009f08e5ef3342801fcc124b97545ba6a6775b2947cc43e6f23e');
});

it('blocks a recovery-only launch when binary patching does not support its installation', async () => {
  assertFixtureHome();
  const presenter: PatchPresenter = { error() {}, warn() {}, success() {}, detail() {}, notice() {}, async confirm() { return false; } };
  const unsupported = { ...installation(), version: '0.0.0' };
  const options = { installation: unsupported, runtime: unreadableRuntime(), routingRecoveryOnly: true } as unknown as NonNullable<Parameters<typeof runLaunchPatchCheckV2>[0]>;

  await expect(runLaunchPatchCheckV2(options, presenter)).rejects.toThrow();
});
