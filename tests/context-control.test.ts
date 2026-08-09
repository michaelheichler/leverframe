import { describe, expect, it } from 'vitest';
import { groupAnthropicContext, type AnthropicMessage } from '../src/context/anthropic-context-groups.js';
import { calculateContextBudget, decideContextHysteresis } from '../src/context/context-budget.js';
import { validateContextWatcherState } from '../src/context/context-watcher-state.js';

const message = (role: AnthropicMessage['role'], content: AnthropicMessage['content']): AnthropicMessage => ({ role, content });

const expectExactOnceCoverage = (result: ReturnType<typeof groupAnthropicContext>, sourceLength: number, systemIndexes: number[] = []): void => {
  const indexes = result.groups.flatMap(group => [...group.messageIndexes]);
  expect(indexes).toHaveLength(sourceLength - systemIndexes.length);
  expect(new Set(indexes).size).toBe(indexes.length);
  expect(indexes.sort((left, right) => left - right)).toEqual(Array.from({ length: sourceLength }, (_, index) => index).filter(index => !systemIndexes.includes(index)));
};

describe('provider-neutral context control core', () => {
  it('keeps system content separate and groups closed tool pairs in order', () => {
    const result = groupAnthropicContext([
      message('system', 'rules'),
      message('assistant', [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }]),
      message('user', 'after'),
    ]);
    expect(result.system).toHaveLength(1);
    expect(result.groups.map(group => group.kind)).toEqual(['tool_pair', 'message']);
    expect(result.groups[0].messageIndexes).toEqual([1, 2]);
    expect(result.groups[0].compactable).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expectExactOnceCoverage(result, 4, [0]);
  });

  it('consumes intervening ordinary messages exactly once', () => {
    const result = groupAnthropicContext([
      message('assistant', [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }]),
      message('user', 'context'),
      message('assistant', 'thinking'),
      message('user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }]),
    ]);
    expect(result.groups.map(group => group.messageIndexes)).toEqual([[0, 1, 2, 3]]);
    expectExactOnceCoverage(result, 4);
  });

  it('diagnoses a reused result and represents it once', () => {
    const result = groupAnthropicContext([
      message('assistant', [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'first' }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'duplicate' }]),
    ]);
    expect(result.diagnostics).toEqual([{ code: 'duplicate_tool_result', messageIndex: 2, blockIndex: 0, toolId: 'call-1', compactable: false }]);
    expect(result.groups.map(group => group.messageIndexes)).toEqual([[0, 1], [2]]);
    expect(result.groups[1].compactable).toBe(false);
    expectExactOnceCoverage(result, 3);
  });

  it('keeps multi-tool result intervals from overlapping later groups', () => {
    const result = groupAnthropicContext([
      message('assistant', [{ type: 'tool_use', id: 'call-1', name: 'one', input: {} }]),
      message('assistant', [{ type: 'tool_use', id: 'call-2', name: 'two', input: {} }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'one' }, { type: 'tool_result', tool_use_id: 'call-2', content: 'two' }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'call-2', content: 'duplicate' }]),
    ]);
    expect(result.groups.map(group => group.messageIndexes)).toEqual([[0, 1, 2], [3]]);
    expect(result.diagnostics.map(item => item.code)).toEqual(['duplicate_tool_result']);
    expectExactOnceCoverage(result, 4);
  });

  it('diagnoses a result whose interval overlaps an already consumed pair', () => {
    const result = groupAnthropicContext([
      message('assistant', [{ type: 'tool_use', id: 'call-1', name: 'one', input: {} }]),
      message('assistant', [{ type: 'tool_use', id: 'call-2', name: 'two', input: {} }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'one' }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'call-2', content: 'two' }]),
    ]);
    expect(result.groups.map(group => group.messageIndexes)).toEqual([[0, 1, 2], [3]]);
    expect(result.groups.every(group => !group.compactable)).toBe(true);
    expect(result.diagnostics).toEqual([
      { code: 'overlapping_tool_result', messageIndex: 3, blockIndex: 0, toolId: 'call-2', compactable: false },
      { code: 'unresolved_tool_call', messageIndex: 1, blockIndex: 0, toolId: 'call-2', compactable: false },
    ]);
    expectExactOnceCoverage(result, 4);
  });

  it('diagnoses tool-shaped blocks in the wrong role without pairing them', () => {
    const result = groupAnthropicContext([
      message('user', [{ type: 'tool_use', id: 'wrong-use', name: 'lookup', input: {} }]),
      message('assistant', [{ type: 'tool_result', tool_use_id: 'wrong-use', content: 'wrong-result' }]),
    ]);
    expect(result.diagnostics.map(item => item.code)).toEqual(['wrong_role_tool_use', 'wrong_role_tool_result']);
    expect(result.groups.map(group => group.messageIndexes)).toEqual([[0], [1]]);
    expect(result.groups.every(group => !group.compactable)).toBe(true);
    expectExactOnceCoverage(result, 2);
  });

  it('reports unresolved, duplicate, orphan, and malformed tool blocks without throwing', () => {
    const result = groupAnthropicContext([
      message('assistant', [{ type: 'tool_use', id: 'same', name: 'a', input: {} }, { type: 'tool_use', id: 'same', name: 'b', input: {} }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }, { type: 'tool_result', content: 'bad' }]),
    ]);
    expect(result.diagnostics.map(item => item.code)).toEqual(['duplicate_tool_id', 'malformed_block', 'orphan_tool_result', 'unresolved_tool_call']);
  });

  it('does not split images or unknown blocks, preserves input, freezes views, and omits plaintext from digests', () => {
    const input = [message('user', [{ type: 'image', source: { data: 'secret-image' } }, { type: 'future_block', text: 'secret-text' }])];
    const result = groupAnthropicContext(input);
    expect(input[0].content).toEqual([{ type: 'image', source: { data: 'secret-image' } }, { type: 'future_block', text: 'secret-text' }]);
    expect(result.groups[0].messages).toEqual(input);
    expect(Object.isFrozen(result.groups[0].messages[0])).toBe(true);
    expect(result.groups[0].sourceDigest).not.toContain('secret');
    expect(result.groups[0].sourceDigest).toMatch(/^lfctx1_[0-9a-f]{64}$/);
  });

  it('uses adaptive budgets for large windows and independent recent-tail input', () => {
    const base = { reservedOutput: 20_000, systemEstimate: 10_000, toolsEstimate: 5_000, messageEstimate: 20_000, imageEstimate: 2_000, safetyOverhead: 4_000, estimatorErrorMargin: 3_000 };
    const twoHundredK = calculateContextBudget({ ...base, modelContextWindow: 200_000, recentTailEstimate: 30_000 });
    const oneMillion = calculateContextBudget({ ...base, modelContextWindow: 1_000_000, recentTailEstimate: 30_000 });
    const largerTail = calculateContextBudget({ ...base, modelContextWindow: 1_000_000, recentTailEstimate: 100_000 });
    expect(twoHundredK.highWatermark).toBeGreaterThan(twoHundredK.lowWatermark);
    expect(oneMillion.highWatermark).toBeGreaterThan(twoHundredK.highWatermark);
    expect(largerTail.highWatermark).toBeLessThan(oneMillion.highWatermark);
  });

  it('returns an explicit unable-to-compact budget for extreme overhead and applies hysteresis', () => {
    const budget = calculateContextBudget({ modelContextWindow: 200_000, reservedOutput: 100_000, systemEstimate: 50_000, toolsEstimate: 20_000, messageEstimate: 20_000, imageEstimate: 5_000, safetyOverhead: 10_000, estimatorErrorMargin: 10_000, recentTailEstimate: 1_000 });
    expect(budget.unableToCompact).toBe(true);
    const usable = calculateContextBudget({ modelContextWindow: 200_000, reservedOutput: 10_000, systemEstimate: 1_000, toolsEstimate: 1_000, messageEstimate: 1_000, imageEstimate: 1_000, safetyOverhead: 1_000, estimatorErrorMargin: 1_000, recentTailEstimate: 1_000 });
    expect(decideContextHysteresis(usable.highWatermark, usable, { action: 'hold' })).toBe('compact');
    expect(decideContextHysteresis(usable.lowWatermark, usable, { action: 'compact' })).toBe('hold');
    expect(decideContextHysteresis((usable.highWatermark + usable.lowWatermark) / 2, usable, { action: 'compact' })).toBe('compact');
  });

  it('validates versioned watcher state strictly and bounds fields', () => {
    const valid = validateContextWatcherState({ version: 1, sessionKey: 'session_1', workspaceScope: 'scope:v1', role: 'main', routeIdentity: 'anthropic:native', contextWindow: 200_000, estimatorVersion: 'tokens-v1', lastObservedUsage: 12_000, rollingCursor: 'r1', archiveCursor: 'a1', generation: 2, healthReason: 'ok' });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(() => validateContextWatcherState({ ...valid, extra: true })).toThrow(/unknown field/);
    expect(() => validateContextWatcherState({ ...valid, healthReason: 'x'.repeat(257) })).toThrow(/health reason/);
    expect(() => validateContextWatcherState({ ...valid, version: 2 })).toThrow(/version/);
  });
});