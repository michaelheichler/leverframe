import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE, ROUTING_NOTICE_ACTIVE_ENV } from '../src/constants.js';
import { CLAUDE_MODULE_BOUNDARY, splitModulePayload } from '../src/claude-bundle-native.js';
import { applyMainRoutingTransform } from '../src/patch-transforms-main-routing.js';
import { applyMainRoutingWireGuard } from '../src/patch-transforms-main-wire.js';
import { applyModelRoutingTransform } from '../src/patch-transforms-model-routing.js';
import { applyRoutingBoundsTransform } from '../src/patch-transforms-routing-bounds.js';
import { applyRoutingPatchComposition, prepareRoutingPatch, ROUTING_RECOVERY_ENTRY } from '../src/patch-transforms-routing-composition.js';
import { applyRoutingRecoveryTransform } from '../src/patch-transforms-routing-recovery.js';
import { CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE } from './fixtures/claude-agent-2.1.314-recovery.js';
import {
  ROUTING_TEST_PROMPT_POLICY,
} from './fixtures/claude-agent-2.1.314-routing.js';
import { noticeFrameSource } from './fixtures/claude-agent-2.1.314-notice-frame.js';
import { noticeHostSource, noticeRequestSource } from './fixtures/claude-agent-2.1.314-notice-host.js';
import { auxiliaryGuardSource, auxiliaryRequestSource } from './fixtures/claude-agent-2.1.314-notice-auxiliary-guard.js';
import { noticeStartupSource } from './fixtures/claude-agent-2.1.314-notice-startup.js';
import { noticeWriterSource } from './fixtures/claude-agent-2.1.314-notice-writer.js';
import { claudeAgentRoutingNoticeCompositionSource } from './fixtures/claude-agent-2.1.314-routing-composition.js';

const visibleModelId = 'auto';
const entry = {
  routingEnabled: true as const,
  routingPolicyModelId: 'leverframe:fixture-router-provider:fixture-router-model',
  routingMetadata: { contextWindow: 80_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low'] },
  routingPromptPolicy: ROUTING_TEST_PROMPT_POLICY,
  routingTargetMetadata: { 'leverframe:fixture-router-provider:fixture-router-model': {
    contextWindow: 80_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low'],
  } },
};

type CompositionMode = 'active' | 'recovery';

function buildNoticeCompositionSource(mode: CompositionMode): string {
  if (mode === 'active') return claudeAgentRoutingNoticeCompositionSource();
  const base = [CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE];
  const writerModule = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-w2wf6pm6.js\n${noticeWriterSource}`;
  const adapterModule = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-f5200rjz.js\nfunction ai(){return{get(){}}}export{ai};`;
  const modules = new Map<string, string>();
  for (const fragment of [...base, writerModule, noticeFrameSource, noticeStartupSource,
    noticeHostSource + noticeRequestSource, auxiliaryGuardSource + auxiliaryRequestSource, adapterModule]) {
    const parsed = splitModulePayload(fragment);
    if (!parsed) throw new Error('A bounded routing fixture has no module boundary.');
    for (const [name, content] of parsed) {
      const previous = modules.get(name);
      modules.set(name, previous === undefined ? content : `${previous}\n${content}`);
    }
  }
  return [...modules].map(([name, content]) => `${CLAUDE_MODULE_BOUNDARY}${name}\n${content}`).join('');
}

function evaluateComposedNoticeRequest(source: string, options: {
  routingActive?: boolean;
  noticeActive?: boolean;
  recoveryCurrent?: () => unknown;
} = {}) {
  const module = splitModulePayload(source)?.find(([name]) => name === '/$bunfs/root/chunk-sq7yspzm.js');
  if (!module) throw new Error('The bounded request module is missing.');
  const code = module[1].replace(/import\{[^}]+\}from"[^"]+";/g, '').replace(/export\{[^}]+\};/g, '');
  const renderer = {
    __lfOutputAbort: new AbortController(),
    nonBlockingStdout: { routingReady: () => true },
    __lfNoticeBridge: { session: { id: 'composition-session' }, ensure: async () => { throw new Error('fixture readiness failure'); } },
  };
  const sandbox = {
    process: { env: {
      ...(options.routingActive ? { [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } : {}),
      ...(options.noticeActive ? { [ROUTING_NOTICE_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } : {}),
    }, stdout: {} },
    URL, AbortController, AbortSignal, TextDecoder, Date, setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'composition-fixture-id' },
    __lfNoticeAi: () => ({ get: () => renderer }),
    __lfRecoveryCurrent: options.recoveryCurrent ?? (() => undefined),
    z: () => 'composition-session',
    __lfNoticeBodyReached: false,
  };
  const scope = runInNewContext(`${code}\n({ request: Fhn })`, sandbox) as {
    request: (...args: unknown[]) => AsyncGenerator<unknown, void, unknown>;
  };
  return {
    async run() {
      const iterator = scope.request([], {}, {}, {}, new AbortController().signal, { modelFacts: undefined });
      return await iterator.next();
    },
    bodyReached: () => sandbox.__lfNoticeBodyReached,
  };
}

const recoveryScopeModulePromise = (() => {
  const transformed = applyRoutingRecoveryTransform(CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE, { enabled: true });
  if (transformed.results[0]?.status !== 'OK') throw new Error('The bounded recovery module did not transform.');
  const marker = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-bqbyxpv1.js\n`;
  const start = transformed.content.indexOf(marker);
  const next = transformed.content.indexOf(CLAUDE_MODULE_BOUNDARY, start + marker.length);
  if (start < 0 || next < 0) throw new Error('The transformed recovery scope module is missing.');
  const moduleSource = transformed.content.slice(start + marker.length, next);
  return import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`) as Promise<{
    __lfRecoveryRun<T>(scope: unknown, action: () => T): T;
    __lfRecoveryCurrent(): unknown;
  }>;
})();

it('blocks the transformed Fhn request until the active host notice bridge is ready', async () => {
  const source = buildNoticeCompositionSource('active');
  const moduleNames = splitModulePayload(source)!.map(([name]) => name);
  expect(new Set(moduleNames).size).toBe(moduleNames.length);
  expect(moduleNames).toEqual(expect.arrayContaining([
    '/$bunfs/root/chunk-3pr91mb5.js', '/$bunfs/root/chunk-pwf6g3a4.js', '/$bunfs/root/chunk-430w8txz.js',
    '/$bunfs/root/chunk-sq7yspzm.js', '/$bunfs/root/chunk-m76gkyft.js', '/$bunfs/root/chunk-w2wf6pm6.js',
    '/$bunfs/root/chunk-51640hmv.js', '/$bunfs/root/chunk-xsq68wek.js', '/$bunfs/root/chunk-01y36vdn.js',
    '/$bunfs/root/chunk-dzek3cak.js',
  ]));
  const composed = applyRoutingPatchComposition(source, visibleModelId, entry);
  expect(composed.results.some(result => result.status === 'FAIL'), JSON.stringify(composed.results)).toBe(false);
  const request = evaluateComposedNoticeRequest(composed.content, { routingActive: true, noticeActive: true });

  await expect(request.run()).rejects.toThrow();
  expect(request.bodyReached()).toBe(false);
});

it('blocks recovery-only requests inside the actual bound recovery scope', async () => {
  const source = buildNoticeCompositionSource('recovery');
  const prepared = prepareRoutingPatch(source, { [ROUTING_RECOVERY_ENTRY]: { routingRecoveryOnly: true } });
  expect(prepared.results.some(result => result.status === 'FAIL'), JSON.stringify(prepared.results)).toBe(false);
  const recovery = await recoveryScopeModulePromise;
  const scope = { kind: 'bound', modelId: 'fixture-bound-model' };
  const request = evaluateComposedNoticeRequest(prepared.content, { noticeActive: true,
    recoveryCurrent: recovery.__lfRecoveryCurrent });

  await expect(recovery.__lfRecoveryRun(scope, () => request.run())).rejects.toThrow();
  expect(request.bodyReached()).toBe(false);
});

it('leaves the native request source unchanged when routing and recovery are off', async () => {
  const source = buildNoticeCompositionSource('active');
  const prepared = prepareRoutingPatch(source, {});
  const request = evaluateComposedNoticeRequest(prepared.content);

  expect(prepared.content).toBe(source);
  await request.run();
  expect(request.bodyReached()).toBe(true);
});

it('reapplies active routing and notice transforms without changing the composed source', () => {
  const source = buildNoticeCompositionSource('active');
  const first = applyRoutingPatchComposition(source, visibleModelId, entry);
  const second = applyRoutingPatchComposition(first.content, visibleModelId, entry);

  expect(first.results.some(result => result.status === 'FAIL'), JSON.stringify(first.results)).toBe(false);
  expect(second.results.some(result => result.status === 'FAIL'), JSON.stringify(second.results)).toBe(false);
  expect(second.content).toBe(first.content);
});

it('skips an intact second application of the model preparation bounds', () => {
  const source = buildNoticeCompositionSource('active');
  const routing = applyModelRoutingTransform(source, { enabled: true, promptPolicy: entry.routingPromptPolicy });
  const main = applyMainRoutingTransform(routing.content, { enabled: true, visibleModelId,
    policyModelId: entry.routingPolicyModelId, metadata: entry.routingMetadata, targetMetadata: entry.routingTargetMetadata });
  const wire = applyMainRoutingWireGuard(main.content, { enabled: true, visibleModelId });
  const first = applyRoutingBoundsTransform(wire.content, { enabled: true, visibleModelId });
  const repeated = applyRoutingBoundsTransform(first.content, { enabled: true, visibleModelId });

  expect(routing.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(main.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(wire.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(first.results[0]?.status).toBe('OK');
  expect(repeated.results[0]?.status).toBe('SKIP');
  expect(repeated.content).toBe(first.content);
});

it('rejects a generated bounds declaration moved away from its module boundary', () => {
  const source = buildNoticeCompositionSource('active');
  const routing = applyModelRoutingTransform(source, { enabled: true, promptPolicy: entry.routingPromptPolicy });
  const main = applyMainRoutingTransform(routing.content, { enabled: true, visibleModelId,
    policyModelId: entry.routingPolicyModelId, metadata: entry.routingMetadata, targetMetadata: entry.routingTargetMetadata });
  const wire = applyMainRoutingWireGuard(main.content, { enabled: true, visibleModelId });
  const moduleBoundary = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-3pr91mb5.js\n`;
  const sentinel = '/*test-fixture-boundary*/';
  const boundedInput = wire.content.replace(moduleBoundary, moduleBoundary + sentinel);
  const first = applyRoutingBoundsTransform(boundedInput, { enabled: true, visibleModelId });
  const declarationStart = first.content.indexOf(moduleBoundary) + moduleBoundary.length;
  const sentinelIndex = first.content.indexOf(sentinel, declarationStart);
  const moduleEnd = first.content.indexOf(CLAUDE_MODULE_BOUNDARY, declarationStart);
  const declaration = first.content.slice(declarationStart, sentinelIndex);
  const moved = first.content.slice(0, declarationStart)
    + first.content.slice(sentinelIndex, moduleEnd) + declaration + first.content.slice(moduleEnd);
  const rejected = applyRoutingBoundsTransform(moved, { enabled: true, visibleModelId });

  expect(routing.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(main.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(wire.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(first.results[0]?.status).toBe('OK');
  expect(declaration.length).toBeGreaterThan(0);
  expect(rejected.results[0]?.status).toBe('FAIL');
  expect(rejected.content).toBe(moved);
});

it('rejects a duplicate generated bounds declaration in the same module', () => {
  const source = buildNoticeCompositionSource('active');
  const routing = applyModelRoutingTransform(source, { enabled: true, promptPolicy: entry.routingPromptPolicy });
  const main = applyMainRoutingTransform(routing.content, { enabled: true, visibleModelId,
    policyModelId: entry.routingPolicyModelId, metadata: entry.routingMetadata, targetMetadata: entry.routingTargetMetadata });
  const wire = applyMainRoutingWireGuard(main.content, { enabled: true, visibleModelId });
  const moduleBoundary = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-3pr91mb5.js\n`;
  const sentinel = '/*test-fixture-boundary*/';
  const boundedInput = wire.content.replace(moduleBoundary, moduleBoundary + sentinel);
  const first = applyRoutingBoundsTransform(boundedInput, { enabled: true, visibleModelId });
  const declarationStart = first.content.indexOf(moduleBoundary) + moduleBoundary.length;
  const sentinelIndex = first.content.indexOf(sentinel, declarationStart);
  const declaration = first.content.slice(declarationStart, sentinelIndex);
  const duplicated = first.content.slice(0, declarationStart) + declaration + first.content.slice(declarationStart);
  const rejected = applyRoutingBoundsTransform(duplicated, { enabled: true, visibleModelId });

  expect(routing.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(main.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(wire.results.some(result => result.status === 'FAIL')).toBe(false);
  expect(first.results[0]?.status).toBe('OK');
  expect(declaration.length).toBeGreaterThan(0);
  expect(rejected.results[0]?.status).toBe('FAIL');
  expect(rejected.content).toBe(duplicated);
});

it('rolls back the whole routing source when a required notice callsite is unavailable', () => {
  const source = buildNoticeCompositionSource('active').replace('async function*Fhn(', 'async function*Fxhn(');
  const applied = applyRoutingPatchComposition(source, visibleModelId, entry);

  expect(applied.content).toBe(source);
  expect(applied.results.some(result => result.status === 'FAIL')).toBe(true);
});
