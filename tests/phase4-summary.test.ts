import { describe, expect, it } from 'vitest';
import { acceptStructuredSynopsis, validateStructuredSynopsis, type StructuredSynopsis } from '../src/context/summary-schema.js';
import { planHierarchicalSummaryBatches, planRollingSummary } from '../src/context/summary-planning.js';

const valid = (sourceIds = ['g1']): StructuredSynopsis => ({ version: 1, taskGoal: 'ship the change', userDecisions: [{ text: 'use the local path', sourceIds }], constraints: [{ text: 'no network', sourceIds }], verifiedFacts: [{ text: 'tests pass', sourceIds }], files: [{ path: 'src/context/summary-schema.ts', relation: 'changed', sourceIds }], toolOutcomes: [{ text: 'vitest passed', status: 'succeeded', sourceIds }], unresolved: [], failedApproaches: [], nextActions: [{ text: 'review the patch', sourceIds }], chronology: [{ order: 1, text: 'implemented the contract', sourceIds }] });

describe('Phase 4 summary schema and acceptance', () => {
  it('accepts a valid synopsis with complete provenance', () => {
    const result = acceptStructuredSynopsis({ candidate: valid(['g1', 'g2']), suppliedSourceIds: ['g1', 'g2'], inputTokens: 20_000, candidateTokens: 100, policy: { minimumReductionRatio: 0.1 } });
    expect(result.accepted).toBe(true);
    expect(result.synopsis?.version).toBe(1);
  });

  it('rejects unknown fields, malformed provenance, unsupported claims, unresolved tools, and reduction failures', () => {
    expect(validateStructuredSynopsis({ ...valid(), extra: true }, ['g1']).rejectionCodes).toContain('unknown_field');
    expect(validateStructuredSynopsis({ ...valid(), userDecisions: [{ text: 'x', sourceIds: ['unknown'] }] }, ['g1']).rejectionCodes).toContain('unknown_source_id');
    expect(acceptStructuredSynopsis({ candidate: valid(), suppliedSourceIds: ['g1'], inputTokens: 10, checker: { unsupportedClaims: ['x'] }, policy: { minimumReductionRatio: 0.9 } }).rejectionCodes).toEqual(expect.arrayContaining(['unsupported_claim', 'reduction_target_not_met']));
    expect(validateStructuredSynopsis({ ...valid(), toolOutcomes: [{ text: 'waiting', status: 'unresolved', sourceIds: ['g1'] }] }, ['g1']).rejectionCodes).toContain('unresolved_tool_provenance');
  });

  it('retains the prior generation on rejection', () => {
    const result = acceptStructuredSynopsis({ candidate: { ...valid(), extra: true }, suppliedSourceIds: ['g1'], inputTokens: 20_000, priorValidGeneration: valid() });
    expect(result.accepted).toBe(false);
    expect(result.priorValidGenerationRetained).toBe(true);
  });
});

describe('Phase 4 summary planning', () => {
  const unit = (id: string, tokens: number, workspaceId = 'w', sessionId = 's', chronology = Number(id.slice(1))) => ({ id, tokenEstimate: tokens, workspaceId, sessionId, kind: 'message_group' as const, chronology });

  it('batches a 500K history below the 128K cap, preserves order, and isolates boundaries', () => {
    const result = planHierarchicalSummaryBatches(Array.from({ length: 10 }, (_, index) => unit(`u${index}`, 50_000)).concat([unit('other', 20_000, 'w2', 's2', 1)]), 500_000);
    expect(result.batches.every(batch => batch.tokenEstimate <= 128_000)).toBe(true);
    expect(result.batches.flatMap(batch => batch.unitIds)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'other']);
    expect(result.batches.at(-1)?.unitIds).toEqual(['other']);
  });

  it('reports an oversized unit explicitly', () => {
    const result = planHierarchicalSummaryBatches([unit('huge', 129_000, 'w', 's', 1)], 128_000);
    expect(result.unmergeableUnitIds).toEqual(['huge']);
    expect(result.batches).toEqual([]);
  });

  it('stops rolling selection at the first unsafe group and keeps job ids stable', () => {
    const groups = [
      { id: 'g1', digest: 'd1', tokenEstimate: 4, chronology: 1, compactable: true },
      { id: 'gap', digest: 'dg', tokenEstimate: 4, chronology: 2, compactable: false },
      { id: 'g2', digest: 'd2', tokenEstimate: 4, chronology: 3, compactable: true },
      { id: 'unresolved', digest: 'du', tokenEstimate: 4, chronology: 4, compactable: true, unresolved: true },
      { id: 'g3', digest: 'd3', tokenEstimate: 4, chronology: 5, compactable: true },
      { id: 'g4', digest: 'd4', tokenEstimate: 4, chronology: 6, compactable: true },
    ];
    const input = { completedGroups: groups, rollingStride: 8, maxRollingInput: 128_000, untouchedRecentTail: 4, policyVersion: 'p1', workspaceId: 'w', sessionId: 's' };
    const first = planRollingSummary(input);
    const second = planRollingSummary(input);
    expect(first.sourceIds).toEqual([]);
    expect(first.blocked).toBe(true);
    expect(first.blockedIds).toEqual(['gap']);
    expect(first.skippedIds).toContain('gap');
    expect(first.jobId).toBe(second.jobId);
  });

  it('stops at unresolved groups without considering later groups', () => {
    const groups = [
      { id: 'g1', digest: 'd1', tokenEstimate: 4, chronology: 1, compactable: true },
      { id: 'unresolved', digest: 'du', tokenEstimate: 4, chronology: 2, compactable: true, unresolved: true },
      { id: 'g2', digest: 'd2', tokenEstimate: 4, chronology: 3, compactable: true },
    ];
    const result = planRollingSummary({ completedGroups: groups, rollingStride: 4, maxRollingInput: 128_000, untouchedRecentTail: 0, policyVersion: 'p1', workspaceId: 'w', sessionId: 's' });
    expect(result.sourceIds).toEqual(['g1']);
    expect(result.blockedIds).toEqual(['unresolved']);
    expect(result.skippedIds).toEqual(['unresolved']);
  });

  it('blocks an unknown prior cursor instead of restarting', () => {
    const result = planRollingSummary({ completedGroups: [{ id: 'g1', digest: 'd1', tokenEstimate: 4, chronology: 1, compactable: true }], priorCursor: 'missing', rollingStride: 4, maxRollingInput: 128_000, untouchedRecentTail: 0, policyVersion: 'p1', workspaceId: 'w', sessionId: 's' });
    expect(result).toMatchObject({ blocked: true, blockedReason: 'prior_cursor_not_found', sourceIds: [] });
  });

  it('rejects duplicate rolling IDs and chronology', () => {
    const base = { id: 'g1', digest: 'd1', tokenEstimate: 4, chronology: 1, compactable: true };
    expect(() => planRollingSummary({ completedGroups: [base, { ...base, digest: 'd2', chronology: 2 }], rollingStride: 4, maxRollingInput: 128_000, untouchedRecentTail: 0, policyVersion: 'p1', workspaceId: 'w', sessionId: 's' })).toThrow('IDs must be unique');
    expect(() => planRollingSummary({ completedGroups: [base, { ...base, id: 'g2' }], rollingStride: 4, maxRollingInput: 128_000, untouchedRecentTail: 0, policyVersion: 'p1', workspaceId: 'w', sessionId: 's' })).toThrow('chronology must be unique');
  });

  it('rejects out-of-order hierarchy chronology and preserves valid boundary streams', () => {
    expect(() => planHierarchicalSummaryBatches([unit('u1', 4), unit('u2', 4, 'w', 's')].map((item, index) => ({ ...item, chronology: index === 0 ? 2 : 1 })), 128_000)).toThrow('chronology must increase');
    const result = planHierarchicalSummaryBatches([unit('a1', 4, 'w1', 's1'), unit('b1', 4, 'w2', 's2'), unit('a2', 4, 'w1', 's1')], 128_000);
    expect(result.batches.map(batch => batch.unitIds)).toEqual([['a1'], ['b1'], ['a2']]);
  });
});