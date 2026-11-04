import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE, ROUTING_NOTICE_ACTIVE_ENV } from '../src/constants.js';
import { applyRoutingAuxiliaryGuardTransform } from '../src/patch-transforms-routing-auxiliary-guard.js';
import { applyRoutingRecoveryTransform } from '../src/patch-transforms-routing-recovery.js';
import { CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE } from './fixtures/claude-agent-2.1.314-recovery.js';
import { auxiliaryGuardSource, auxiliaryRequestSource } from './fixtures/claude-agent-2.1.314-notice-auxiliary-guard.js';

type RecoveryScopeModule = {
  __lfRecoveryRun<T>(scope: unknown, action: () => T): T;
  __lfRecoveryCurrent(): unknown;
};

type AuxiliaryCounters = {
  inferenceCalls: number;
  quotaSent: number;
  countTokenSent: number;
  alternateCountSent: number;
  apiKeyVerifySent: number;
};

type AuxiliaryFunctions = {
  et(...args: unknown[]): Promise<unknown>;
  QVe(...args: unknown[]): Promise<unknown>;
  axo(...args: unknown[]): Promise<unknown>;
  I5s(...args: unknown[]): Promise<boolean>;
  Lyr: { Mr(input: { beta: { messages: { create(): Promise<unknown> } } }): Promise<unknown> };
};

type AuxiliaryHarness = { functions: AuxiliaryFunctions; counters: AuxiliaryCounters; recoveryImports(): number };

const recoveryScopeModulePromise = (() => {
  const transformed = applyRoutingRecoveryTransform(CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE, { enabled: true });
  if (transformed.results[0]?.status !== 'OK') throw new Error('The retained recovery module fixture did not transform.');
  const marker = '\n//#__leverframe_claude_module__:/$bunfs/root/chunk-bqbyxpv1.js\n';
  const start = transformed.content.indexOf(marker);
  const next = transformed.content.indexOf('\n//#__leverframe_claude_module__:', start + marker.length);
  if (start < 0 || next < 0) throw new Error('The transformed recovery export module is missing.');
  const moduleSource = transformed.content.slice(start + marker.length, next);
  const dataUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`;
  return import(dataUrl) as Promise<RecoveryScopeModule>;
})();

function evaluateAuxiliaryGuard(options: {
  routingActive?: boolean;
  noticeActive?: boolean;
  countTokensUnneeded?: boolean;
  recoveryModuleFactory?: () => Promise<unknown> | unknown;
} = {}): AuxiliaryHarness {
  const transformed = applyRoutingAuxiliaryGuardTransform(auxiliaryGuardSource + auxiliaryRequestSource, { enabled: true });
  if (transformed.results[0]?.status !== 'OK') throw new Error('The bounded auxiliary fixture was not transformed.');
  const executable = transformed.content.replace(/import\((['"])[^'"]+\/chunk-[^'"]+\.js\1\)/g,
    'globalThis.__lfRecoveryModuleFactory()');
  const counters: AuxiliaryCounters = { inferenceCalls: 0, quotaSent: 0, countTokenSent: 0,
    alternateCountSent: 0, apiKeyVerifySent: 0 };
  let recoveryImports = 0;
  const vmGlobals = {
    process: { env: {
      ...(options.routingActive ? { [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } : {}),
      ...(options.noticeActive ? { [ROUTING_NOTICE_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } : {}),
    } },
    X: () => options.countTokensUnneeded === true,
    EN: async () => { counters.inferenceCalls++; return undefined; },
    W1e: (value: unknown) => value,
    _s: () => undefined,
    __lfRecoveryModuleFactory: async () => {
      recoveryImports++;
      return options.recoveryModuleFactory ? await options.recoveryModuleFactory() : {};
    },
    counters,
  };
  const scope = runInNewContext(`${executable}\n({ et, QVe, axo, I5s, Lyr })`, vmGlobals);

  return { functions: scope as AuxiliaryFunctions, counters, recoveryImports: () => recoveryImports };
}

it('blocks the quota check before its model request while routing is active', async () => {
  const harness = evaluateAuxiliaryGuard({ routingActive: true });

  await expect(harness.functions.et({}, {}, new AbortController().signal)).rejects.toThrow();

  expect(harness.counters.inferenceCalls).toBe(0);
  expect(harness.counters.quotaSent).toBe(0);
  expect(harness.recoveryImports()).toBe(0);
});

it('keeps QVe early-exit behavior ahead of the active guard', async () => {
  const harness = evaluateAuxiliaryGuard({ routingActive: true, noticeActive: true, countTokensUnneeded: true });

  await expect(harness.functions.QVe([], [], undefined, {})).resolves.toBeNull();

  expect(harness.counters.inferenceCalls).toBe(0);
  expect(harness.counters.alternateCountSent).toBe(0);
  expect(harness.recoveryImports()).toBe(0);
});

it('lets guarded token counting return null so local estimation can proceed without model fallback calls', async () => {
  const recovery = await recoveryScopeModulePromise;
  const bound = { kind: 'bound', modelId: 'fixture-bound-model' };
  const harness = evaluateAuxiliaryGuard({ noticeActive: true, recoveryModuleFactory: () => recovery });
  const localEstimate = await recovery.__lfRecoveryRun(bound, async () => {
    const count = await harness.functions.QVe([{ role: 'user', content: 'fixture' }], [], undefined, {});
    return count ?? 321;
  });

  expect(localEstimate).toBe(321);
  expect(harness.counters.inferenceCalls).toBe(0);
  expect(harness.counters.alternateCountSent).toBe(0);
  expect(harness.recoveryImports()).toBe(1);
});

it('blocks the alternate count-token request before its model adapter while routing is active', async () => {
  const harness = evaluateAuxiliaryGuard({ routingActive: true });

  await expect(harness.functions.axo([], [], {})).rejects.toThrow();

  expect(harness.counters.alternateCountSent).toBe(0);
  expect(harness.recoveryImports()).toBe(0);
});

it('blocks API-key verification before provider inference in bound recovery', async () => {
  const recovery = await recoveryScopeModulePromise;
  const bound = { kind: 'bound', modelId: 'fixture-bound-model' };
  const harness = evaluateAuxiliaryGuard({ noticeActive: true, recoveryModuleFactory: () => recovery });

  await expect(recovery.__lfRecoveryRun(bound, () => harness.functions.I5s('fixture-key', false, {}, {}))).rejects.toThrow();

  expect(harness.counters.apiKeyVerifySent).toBe(0);
  expect(harness.recoveryImports()).toBe(1);
});

it('keeps API-key verification early exit when the credential is already accepted', async () => {
  const harness = evaluateAuxiliaryGuard({ routingActive: true });

  await expect(harness.functions.I5s('fixture-key', true, {}, {})).resolves.toBe(true);

  expect(harness.counters.apiKeyVerifySent).toBe(0);
  expect(harness.recoveryImports()).toBe(0);
});

it('checks recovery scope again before a recursive model request retry', async () => {
  let currentRecovery: unknown = { kind: 'unbound' };
  const harness = evaluateAuxiliaryGuard({ noticeActive: true, recoveryModuleFactory: () => ({
    __lfRecoveryCurrent: () => currentRecovery,
  }) });
  let sends = 0;
  const model = { beta: { messages: { create: async () => {
    sends++;
    currentRecovery = { kind: 'bound', modelId: 'fixture-bound-model' };
    throw Object.assign(new Error('Synthetic rejected attempt.'), { retry: true });
  } } } };

  await expect(harness.functions.Lyr.Mr(model)).rejects.toThrow();

  expect(sends).toBe(1);
  expect(harness.recoveryImports()).toBe(2);
});

it('keeps quota checking available when routing is disabled', async () => {
  const harness = evaluateAuxiliaryGuard();

  await harness.functions.et({}, {}, new AbortController().signal);

  expect(harness.counters.inferenceCalls).toBe(1);
  expect(harness.recoveryImports()).toBe(0);
});

it('allows the quota check inside an actual unbound recovery scope', async () => {
  const recovery = await recoveryScopeModulePromise;
  const harness = evaluateAuxiliaryGuard({ noticeActive: true, recoveryModuleFactory: () => recovery });
  const result = await recovery.__lfRecoveryRun({ kind: 'unbound' }, () =>
    harness.functions.et({}, {}, new AbortController().signal));

  expect(result).toBeUndefined();
  expect(harness.counters.inferenceCalls).toBe(1);
  expect(harness.counters.quotaSent).toBe(1);
});

it('preserves API-key verification in unbound recovery', async () => {
  const recovery = await recoveryScopeModulePromise;
  const harness = evaluateAuxiliaryGuard({ noticeActive: true, recoveryModuleFactory: () => recovery });
  const verified = await recovery.__lfRecoveryRun({ kind: 'unbound' }, () =>
    harness.functions.I5s('fixture-key', false, {}, {}));

  expect(verified).toBe(true);
  expect(harness.counters.apiKeyVerifySent).toBe(1);
});

it('preserves the real recovery AsyncLocalStorage export across async continuations', async () => {
  const recovery = await recoveryScopeModulePromise;
  const bound = { kind: 'bound', modelId: 'fixture-bound-model' };
  const observed = await recovery.__lfRecoveryRun(bound, async () => {
    await Promise.resolve();
    return recovery.__lfRecoveryCurrent();
  });

  expect(observed).toEqual(bound);
});
