import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compactAnthropicRequest, createLeverframeSummaryEnvelope, type AnthropicRequestLike, type CompactionMessage, type StructuredSynopsis } from '../src/context/request-compaction.js';
import { groupAnthropicContext } from '../src/context/anthropic-context-groups.js';

const synopsis: StructuredSynopsis = { text: 'Earlier work established the fixture state.', facts: ['fixture'] };
const identity = { routeIdentity: 'route:test', policyVersion: 'policy:1', generation: 'generation:7' };

const request = (): AnthropicRequestLike => ({
  model: 'fixture-model',
  system: [{ type: 'text', text: 'Never change this system block.', unknown: { keep: true } }],
  messages: [
    { role: 'user', content: 'old user', unknown_field: { keep: 'yes' } },
    { role: 'assistant', content: 'old answer' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: { q: 'fixture' }, extra: true }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output', extra: { keep: true } }] },
    { role: 'user', content: 'recent tail', future_field: 42 },
  ],
  future_top_level: { untouched: true },
});

const grouped = (body: AnthropicRequestLike) => groupAnthropicContext(body.messages as never);
const compactInput = (body: AnthropicRequestLike, overrides: Record<string, unknown> = {}) => {
  const context = grouped(body);
  const covered = context.groups.slice(0, 2).map(group => ({ sourceDigest: group.sourceDigest }));
  const tail = context.groups.slice(-1).map(group => group.sourceDigest);
  return {
    request: body,
    groups: context.groups,
    synopsis,
    coveredSources: covered,
    untouchedTailGroupIds: tail,
    estimateTokens: () => 10,
    lowWatermark: 100,
    ...identity,
    ...overrides,
  };
};
type EnvelopeMutation = (envelope: ReturnType<typeof createLeverframeSummaryEnvelope>) => Record<string, unknown>;
type BodyMutation = (body: AnthropicRequestLike) => AnthropicRequestLike;

describe('pure request compaction', () => {
  it('compacts whole groups and preserves system, tail, tools, and unknown fields', () => {
    const original = request();
    const result = compactAnthropicRequest(compactInput(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compactedRequest).not.toBe(original);
    expect(result.compactedRequest.system).toBe(original.system);
    expect(result.compactedRequest.future_top_level).toBe(original.future_top_level);
    expect(result.compactedRequest.messages.at(-1)).toBe(original.messages.at(-1));
    expect(result.compactedRequest.messages).toHaveLength(4);
    expect(result.compactedRequest.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text' }] });
    expect(result.compactedRequest.messages[3]).toBe(original.messages[4]);
    expect(JSON.stringify(result.compactedRequest.messages)).toContain('tool-1');
    expect(JSON.stringify(result.compactedRequest.messages)).toContain('tool output');
  });

  it.each([
    ['partial coverage', { coveredSources: [] }, 'invalid_coverage'],
    ['unknown coverage', { coveredSources: [{ sourceDigest: 'missing' }] }, 'invalid_coverage'],
    ['overlap with tail', { untouchedTailGroupIds: [grouped(request()).groups[0].sourceDigest] }, 'invalid_coverage'],
    ['low watermark', { lowWatermark: 1 }, 'estimate_above_low_watermark'],
    ['estimator throw', { estimateTokens: () => { throw new Error('fixture'); } }, 'estimator_unavailable'],
    ['estimator non-finite', { estimateTokens: () => Number.NaN }, 'estimator_unavailable'],
  ])('returns the exact original reference for %s', (_name, overrides, reason) => {
    const original = request();
    const result = compactAnthropicRequest(compactInput(original, overrides));
    expect(result).toMatchObject({ ok: false, originalRequest: original, reason });
  });

  it('rejects duplicate, overlapping, and non-partitioned groups', () => {
    const original = request();
    const context = grouped(original);
    const duplicate = compactAnthropicRequest(compactInput(original, { groups: [...context.groups, context.groups[0]] }));
    expect(duplicate).toMatchObject({ ok: false, originalRequest: original, reason: 'invalid_partition' });
    const overlap = compactAnthropicRequest(compactInput(original, { groups: context.groups.map(group => ({ ...group, messageIndexes: group.messageIndexes.slice(0, 1) })) }));
    expect(overlap).toMatchObject({ ok: false, originalRequest: original, reason: 'invalid_partition' });
  });

  it('is deterministic and idempotent without recursive summaries', () => {
    const first = compactAnthropicRequest(compactInput(request()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const secondBody = first.compactedRequest;
    const secondContext = grouped(secondBody);
    const second = compactAnthropicRequest({ ...compactInput(secondBody), groups: secondContext.groups, coveredSources: compactInput(request()).coveredSources, untouchedTailGroupIds: [] });
    expect(second).toMatchObject({ ok: true, compactedRequest: secondBody, alreadyCompacted: true, decisionKey: first.decisionKey });
    expect(JSON.stringify(secondBody).match(/LEVERFRAME_SUMMARY_V1:/g)).toHaveLength(1);
  });

  it('rejects malformed or duplicate existing envelopes and identity mismatch', () => {
    const original = request();
    const malformedMessage: CompactionMessage = { role: 'user', content: [{ type: 'text', text: 'LEVERFRAME_SUMMARY_V1:{bad' }] };
    const malformed = compactAnthropicRequest(compactInput({ ...original, messages: [malformedMessage, ...original.messages] }));
    expect(malformed).toMatchObject({ ok: false, originalRequest: expect.anything(), reason: 'envelope_malformed' });
    const envelope = createLeverframeSummaryEnvelope({ summaryGeneration: identity.generation, identity, coveredSources: [{ sourceDigest: 'lfctx1_fixture' }], synopsis });
    const summaryMessage: CompactionMessage = { role: 'user', content: [{ type: 'text', text: `LEVERFRAME_SUMMARY_V1:${JSON.stringify(envelope)}` }] };
    const withTwo = { ...original, messages: [summaryMessage, summaryMessage, ...original.messages] };
    const duplicate = compactAnthropicRequest(compactInput(withTwo));
    expect(duplicate).toMatchObject({ ok: false, originalRequest: withTwo, reason: 'envelope_duplicate' });
    const existing = firstEnvelopeRequest(original);
    const mismatch = compactAnthropicRequest(compactInput(existing, { routeIdentity: 'route:other' }));
    expect(mismatch).toMatchObject({ ok: false, originalRequest: existing, reason: 'identity_mismatch' });
  });

  const envelopeMutations: Array<[string, EnvelopeMutation]> = [
    ['forged decision key', envelope => ({ ...envelope, decisionKey: `lfcmp1_${'0'.repeat(64)}` })],
    ['unknown envelope field', envelope => ({ ...envelope, unexpected: true })],
    ['stale synopsis', envelope => rekeyEnvelope({ ...envelope, synopsis: { ...envelope.synopsis, text: 'stale synopsis' } })],
    ['stale coverage', envelope => rekeyEnvelope({ ...envelope, coveredSources: [{ sourceDigest: 'lfctx1_stale' }] })],
    ['stale generation', envelope => rekeyEnvelope({ ...envelope, generation: 'generation:old', summaryGeneration: 'generation:old' })],
  ];

  it.each(envelopeMutations)('rejects %s and preserves the original request', (_name, mutate) => {
    const original = request();
    const expected = createLeverframeSummaryEnvelope({ summaryGeneration: identity.generation, identity, coveredSources: compactInput(original).coveredSources, synopsis });
    const forged = mutate(expected);
    const withEnvelope = { ...original, messages: [summaryMessage(forged), ...original.messages] };
    const result = compactAnthropicRequest(compactInput(withEnvelope));
    expect(result).toMatchObject({ ok: false, originalRequest: withEnvelope, reason: _name.startsWith('stale') ? 'identity_mismatch' : 'envelope_malformed' });
  });

  it('rejects an oversized envelope marker', () => {
    const original = request();
    const oversized = {
      ...createLeverframeSummaryEnvelope({ summaryGeneration: identity.generation, identity, coveredSources: compactInput(original).coveredSources, synopsis }),
      synopsis: { text: 'x'.repeat(20_000) },
    };
    const withEnvelope = { ...original, messages: [summaryMessage(oversized), ...original.messages] };
    const result = compactAnthropicRequest(compactInput(withEnvelope));
    expect(result).toMatchObject({ ok: false, originalRequest: withEnvelope, reason: 'envelope_malformed' });
  });

  const bodyMutations: Array<[string, BodyMutation]> = [
    ['duplicate tool use', body => ({ ...body, messages: [...body.messages, body.messages[2]] })],
    ['orphan tool result', body => ({ ...body, messages: body.messages.map((message: CompactionMessage) => Array.isArray(message.content) && message.content.some((block: unknown) => typeof block === 'object' && block !== null && 'tool_use_id' in block) ? { ...message, content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'tool output' }] } : message) })],
    ['unresolved tool use', body => ({ ...body, messages: body.messages.map((message: CompactionMessage) => Array.isArray(message.content) && message.content.some((block: unknown) => typeof block === 'object' && block !== null && 'id' in block) ? { ...message, content: [{ type: 'tool_use', id: 'unresolved', name: 'lookup', input: {} }] } : message) })],
  ];

  it.each(bodyMutations)('rejects %s even when supplied groups claim compactable', (_name, mutate) => {
    const original = request();
    const unsafe = mutate(original);
    const context = grouped(unsafe);
    const result = compactAnthropicRequest(compactInput(unsafe, {
      groups: context.groups.map(group => ({ ...group, compactable: true })),
    }));
    expect(result).toMatchObject({ ok: false, originalRequest: unsafe, reason: 'tool_boundary' });
  });
});

function firstEnvelopeRequest(original: AnthropicRequestLike): AnthropicRequestLike {
  const envelope = createLeverframeSummaryEnvelope({ summaryGeneration: identity.generation, identity, coveredSources: compactInput(original).coveredSources, synopsis });
  return { ...original, messages: [summaryMessage(envelope), ...original.messages] };
}

function summaryMessage(envelope: object): CompactionMessage {
  return { role: 'user', content: [{ type: 'text', text: `LEVERFRAME_SUMMARY_V1:${JSON.stringify(envelope)}` }] };
}

function rekeyEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  const { decisionKey: _decisionKey, ...base } = envelope;
  const canonical = stableJsonForTest(base);
  return { ...envelope, decisionKey: `lfcmp1_${createHash('sha256').update(canonical, 'utf8').digest('hex')}` };
}

function stableJsonForTest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonForTest).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonForTest((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}