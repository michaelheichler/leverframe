import { describe, expect, it, vi } from 'vitest';
import { selectorReasons } from '../src/model-routing.js';
import * as routing from '../src/model-routing.js';

const ref = (providerId: string, modelId: string) => ({ providerId, modelId });
const candidates = [ref('provider-a', 'model-a'), ref('provider-b', 'model-b')];
const outsideTier = ref('provider-c', 'model-c');
const selectorTarget = ref('selector-provider', 'selector-model');
const validTaskSignature = 'a'.repeat(64);
const rates = (amount: number) => ({ kind: 'known', currency: 'USD', unit: 'per-million-tokens', input: amount, output: amount, cacheRead: amount, cacheWrite: amount, substituted: false, freshness: 'current' });
const catalogModel = (modelRef: ReturnType<typeof ref>, amount: number) => ({ ref: modelRef,
  credential: { source: 'registry', authRef: 'fixture', kind: 'api_key', available: true }, billing: { kind: 'metered' },
  discovery: { source: 'registry', state: 'current', confirmed: true, fetchedAt: 'fixture' },
  capabilities: { tools: true, images: true, reasoning: true, promptCache: true, websocket: true },
  confirmedCapabilities: ['tools', 'images', 'reasoning', 'promptCache', 'websocket'], supportedReasoningEfforts: ['balanced', 'deep'],
  contextWindow: 100_000, contextWindowConfirmed: true, estimate: rates(amount),
});
const ordered = [
  { ref: candidates[0], estimate: { kind: 'known', amount: 0.00001 } },
  { ref: candidates[1], estimate: { kind: 'known', amount: 0.00001 } },
  { ref: outsideTier, estimate: { kind: 'known', amount: 0.001 } },
];
const baseDecision = { target: candidates[0], effort: 'balanced', ordered, estimate: ordered[0].estimate,
  policy: 'execution', policyVersion: '1', source: 'pool', reason: 'deterministic', events: [] };
const evidence = { category: 'review', effort: 'balanced', candidateSetVersion: 'candidate-v', signatureVersion: 'signature-v',
  sampleSize: 4, sourceEvaluationId: 'eval', measuredAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-10-01T00:00:00.000Z',
  avoidedTokens: { input: 500, output: 100 } };
const selectorConfig = (item: unknown = evidence) => ({ selector: { enabled: true, target: selectorTarget, maxExtraCallsPerTask: 1,
  timeoutMs: 250, maxOutputTokens: 24, evaluationEvidence: Array.isArray(item) ? item : [item] } });
const selectorCatalog = () => ({ generatedAt: 'fixture', models: [catalogModel(candidates[0], 5), catalogModel(candidates[1], 5),
  catalogModel(outsideTier, 100), catalogModel(selectorTarget, 0.1)] });
const selectorInput = (extra: Record<string, unknown> = {}) => ({ decision: baseDecision, config: selectorConfig(), catalog: selectorCatalog(),
  category: 'review', effort: 'balanced', requirements: {}, features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
  taskSignature: validTaskSignature, candidateSetVersion: 'candidate-v', signatureVersion: 'signature-v', jobId: 'job-one',
  selectorWorkload: { input: 40, output: 24 }, ...extra });
const dependencies = (overrides: Record<string, unknown> = {}) => ({ now: () => Date.parse('2026-11-01T00:00:00.000Z'),
  call: vi.fn(async () => candidates[1]), cache: new Map(), reserveCall: vi.fn(() => true), ...overrides });
type DecisionLike = { target: unknown; effort?: unknown; ordered: unknown; estimate: unknown; policy: unknown; policyVersion: unknown;
  source: unknown; reason: string; events: Array<{ reason: string }> };
const select = (input: unknown, deps: unknown) => (routing as unknown as {
  selectRoutingTie: (value: unknown, dependencies: unknown) => Promise<DecisionLike>;
}).selectRoutingTie(input, deps);
const hasEvent = (decision: { events: Array<{ reason: string }> }) => decision.events.some(event => event.reason.length > 0);
const deterministicFields = (decision: DecisionLike) => ({ target: decision.target, effort: decision.effort, ordered: decision.ordered,
  estimate: decision.estimate, policy: decision.policy, policyVersion: decision.policyVersion, source: decision.source });
function expectFallback(decision: DecisionLike, reason: string): void {
  expect(deterministicFields(decision)).toEqual(deterministicFields(baseDecision));
  expect(decision.reason).toBe(reason);
  expect(decision.events.at(-1)?.reason).toBe(reason);
}

describe('same-tier selector', () => {
  it('uses qualifying selector output and sends only compact captured features', async () => {
    const call = vi.fn(async (_target: unknown, _payload: unknown) => candidates[1]);
    const decision = await select(selectorInput(), dependencies({ call }));
    const payload = call.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(decision.target).toEqual(candidates[1]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ category: 'review', effort: 'balanced', taskSignature: validTaskSignature, maxOutputTokens: 24 });
    expect(payload).not.toHaveProperty('prompt');
    expect(payload).not.toHaveProperty('sourceFiles');
    expect(payload).not.toHaveProperty('credentials');
    expect(payload).not.toHaveProperty('workerTools');
  });

  it('removes prompt-like fields from captured selector inputs', async () => {
    const call = vi.fn(async (_target: unknown, _payload: unknown) => candidates[1]);
    const sensitive = 'private task text';
    const input = selectorInput({ features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0, prompt: sensitive },
      requirements: { capabilities: ['tools'], sourceFiles: [sensitive], credentials: sensitive } });
    const decision = await select(input, dependencies({ call }));
    const payload = call.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(decision.target).toEqual(candidates[1]);
    expect(JSON.stringify(payload)).not.toContain(sensitive);
  });

  it('copies only model references from candidate pool entries into the payload', async () => {
    const sensitive = 'account secret';
    const candidate = { ...candidates[0], prompt: sensitive, token: sensitive };
    const catalog = selectorCatalog();
    const decision = (routing as unknown as { decideRouting: (input: unknown) => unknown }).decideRouting({
      config: { enabled: true, pool: [candidate, candidates[1]] }, catalog, role: 'specialist', workload: { input: 40, output: 24 },
    });
    const call = vi.fn(async (_target: unknown, _payload: unknown) => candidates[1]);
    await select(selectorInput({ decision, catalog }), dependencies({ call }));
    const payload = call.mock.calls[0]?.[1] as { candidates: Array<{ ref: unknown }> };
    expect(payload.candidates[0]?.ref).toEqual(candidates[0]);
    expect(JSON.stringify(payload)).not.toContain(sensitive);
  });

  it('keeps the deterministic target and aborts after timeout', async () => {
    let aborted = false;
    const call = vi.fn((_target: unknown, _payload: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => { aborted = true; reject(new Error()); }, { once: true })));
    const decision = await select(selectorInput(), dependencies({ call }));
    expectFallback(decision, selectorReasons.timeout);
    expect(aborted).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('selector eligibility and economics', () => {
  it('rejects selector output outside the eligible cost tier', async () => {
    const call = vi.fn(async () => outsideTier);
    const decision = await select(selectorInput(), dependencies({ call }));
    expectFallback(decision, selectorReasons.invalidResult);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('rejects selector output that is absent from the eligible candidate set', async () => {
    const call = vi.fn(async () => ref('unlisted-provider', 'unlisted-model'));
    const decision = await select(selectorInput(), dependencies({ call }));
    expectFallback(decision, selectorReasons.invalidResult);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('skips calls when evaluation evidence is absent', async () => {
    const call = vi.fn(async () => candidates[1]);
    const decision = await select(selectorInput({ config: selectorConfig([]) }), dependencies({ call }));
    expect(decision.target).toEqual(baseDecision.target);
    expect(hasEvent(decision)).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('skips calls when evaluation evidence is stale', async () => {
    const call = vi.fn(async () => candidates[1]);
    const stale = { ...evidence, expiresAt: '2026-10-01T00:00:01.000Z' };
    const decision = await select(selectorInput({ config: selectorConfig(stale) }), dependencies({ call }));
    expect(decision.target).toEqual(baseDecision.target);
    expect(hasEvent(decision)).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('skips selector calls when evaluation sample count is invalid', async () => {
    const call = vi.fn(async () => candidates[1]);
    const decision = await select(selectorInput({ config: selectorConfig({ ...evidence, sampleSize: 0 }) }), dependencies({ call }));
    expect(decision.target).toEqual(baseDecision.target);
    expect(hasEvent(decision)).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects prompt-like task signatures before selector dispatch', async () => {
    const call = vi.fn(async () => candidates[1]);
    const decision = await select(selectorInput({ taskSignature: 'reveal_private_key' }), dependencies({ call }));
    expectFallback(decision, selectorReasons.invalidSignature);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'candidate set', override: { candidateSetVersion: 'unmatched-candidates' } },
    { label: 'signature format', override: { signatureVersion: 'unmatched-signature' } },
  ])('skips selector calls when evaluation evidence has a mismatched $label', async ({ override }) => {
    const call = vi.fn(async () => candidates[1]);
    const decision = await select(selectorInput(override), dependencies({ call }));
    expect(decision.target).toEqual(baseDecision.target);
    expect(hasEvent(decision)).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('uses current selector prices before deciding whether a call can save money', async () => {
    const call = vi.fn(async () => candidates[1]);
    const catalog = { ...selectorCatalog(), models: [catalogModel(candidates[0], 5), catalogModel(candidates[1], 5), catalogModel(selectorTarget, 1000)] };
    const decision = await select(selectorInput({ catalog }), dependencies({ call }));
    expect(decision.target).toEqual(baseDecision.target);
    expect(hasEvent(decision)).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('resolves an omitted selector target from the configured router target', async () => {
    const call = vi.fn(async (_target: unknown, _payload: unknown) => candidates[1]);
    const config = { ...selectorConfig(), cheapFallback: selectorTarget,
      selector: { ...selectorConfig().selector, target: undefined } };
    const decision = await select(selectorInput({ config }), dependencies({ call }));

    expect(decision.target).toEqual(candidates[1]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toEqual(selectorTarget);
  });
});

describe('selector cache and call budget', () => {
  it('shares a semantic result across jobs with the same task signature', async () => {
    const call = vi.fn(async () => candidates[1]);
    const deps = dependencies({ call });
    const first = await select(selectorInput(), deps);
    const second = await select(selectorInput({ jobId: 'job-two' }), deps);
    expect(first.target).toEqual(second.target);
    expect(hasEvent(second)).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('applies a waiting jobs deadline without cancelling the shared call', async () => {
    let complete: (value: ReturnType<typeof ref>) => void = () => undefined;
    let aborted = false;
    const pending = new Promise<ReturnType<typeof ref>>(resolve => { complete = resolve; });
    const call = vi.fn((_target: unknown, _payload: unknown, signal: AbortSignal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return pending;
    });
    const deps = dependencies({ now: () => Date.now(), call });
    const first = select(selectorInput(), deps);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    const second = select(selectorInput({ deadline: Date.now() + 10, jobId: 'job-two' }), deps);
    await new Promise(resolve => setTimeout(resolve, 20));
    const secondResult = await Promise.race([second, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 20))]);
    complete(candidates[1]);
    const firstResult = await first;
    expectFallback(secondResult!, selectorReasons.timeout);
    expect(firstResult.target).toEqual(candidates[1]);
    expect(aborted).toBe(false);
  });

  it('reserves a concurrent per-job call budget atomically', async () => {
    let reserved = false;
    const reserveCall = vi.fn(async () => { if (reserved) return false; reserved = true; await Promise.resolve(); return true; });
    const call = vi.fn(async () => candidates[1]);
    const deps = dependencies({ call, reserveCall });
    const results = await Promise.all([select(selectorInput(), deps), select(selectorInput({ taskSignature: 'b'.repeat(64) }), deps)]);
    const capped = results.find(result => result.reason === selectorReasons.callCap);
    expect(capped).toBeDefined();
    expectFallback(capped!, selectorReasons.callCap);
    expect(call).toHaveBeenCalledTimes(1);
    expect(reserveCall).toHaveBeenCalledTimes(2);
  });

  it('keeps the deterministic target when selector transport fails', async () => {
    const call = vi.fn(async () => { throw new Error(); });
    const decision = await select(selectorInput(), dependencies({ call }));
    expectFallback(decision, selectorReasons.transportFailure);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('selector input validation', () => {
  it('rejects prompt text in runtime feature buckets or capability labels', async () => {
    const sensitive = 'private task text';
    const call = vi.fn(async () => candidates[1]);
    const input = selectorInput({ features: { size: sensitive, turns: 'few', tools: 'none', recentFailures: 0 },
      requirements: { capabilities: [sensitive] } });
    const decision = await select(input, dependencies({ call }));
    expectFallback(decision, selectorReasons.invalidSignature);
    expect(call).not.toHaveBeenCalled();
  });

  it('prices selector overhead at the configured output bound', async () => {
    const call = vi.fn(async () => candidates[1]);
    const catalog = { generatedAt: 'fixture', models: [catalogModel(candidates[0], 0.5), catalogModel(candidates[1], 0.5),
      catalogModel(selectorTarget, 5)] };
    const input = selectorInput({ catalog, selectorWorkload: { input: 40, output: 8 } });
    const decision = await select(input, dependencies({ call }));
    expect(decision.target).toEqual(baseDecision.target);
    expect(hasEvent(decision)).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});
