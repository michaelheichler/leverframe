import { expect, it } from 'vitest';
import { beginExecutionTracking, reconcileIncomingToolResults } from '../src/execution-tracking.js';
import { loadCheckpoint } from '../src/execution-checkpoint.js';
import { reconcileExecution } from '../src/execution-recovery.js';
import { beginEmitting, createEmptyLedger, loadLedger, planToolCall, saveLedgerCAS, withEntry } from '../src/tool-call-ledger.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-resume-validation');
const input = { sessionKey: 'session', requestId: 'request', provider: 'fake', model: 'fake',
  route: 'passthrough' as const, messages: [{ role: 'user', content: 'original' }] };

it('rejects changed history before advancing the checkpoint', () => {
  const handle = beginExecutionTracking(input);
  expect(() => beginExecutionTracking({ ...input, executionId: handle.executionId,
    messages: [{ role: 'user', content: 'different' }] })).toThrow(/conversation/i);
  expect(loadCheckpoint(handle.scopeHash, handle.executionId).generation).toBe(1);
});

it('rejects a missing confirmed result even when the original history matches', () => {
  const handle = beginExecutionTracking(input);
  handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] });
  reconcileIncomingToolResults({ sessionKey: input.sessionKey, toolResults: [{ toolUseId: 'call', content: 'result' }] });
  expect(() => beginExecutionTracking({ ...input, executionId: handle.executionId })).toThrow(/result/i);
});

it('accepts preserved history and confirmed results across successive resumes', () => {
  const handle = beginExecutionTracking(input);
  handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] });
  const toolResults = [{ toolUseId: 'call', content: 'result' }];
  reconcileIncomingToolResults({ sessionKey: input.sessionKey, toolResults });
  const messages = [...input.messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] }];
  const resumed = beginExecutionTracking({ ...input, executionId: handle.executionId, messages, toolResults });
  expect(resumed.executionId).toBe(handle.executionId);
  expect(loadCheckpoint(handle.scopeHash, handle.executionId).value?.messageDigests).toHaveLength(3);
  expect(() => beginExecutionTracking({ ...input, executionId: handle.executionId, toolResults })).toThrow(/conversation/i);
  expect(beginExecutionTracking({ ...input, executionId: handle.executionId,
    messages: [...messages, { role: 'user', content: 'continue' }], toolResults }).executionId).toBe(handle.executionId);
});

it('rejects a changed confirmed result before checkpoint publication', () => {
  const handle = beginExecutionTracking(input);
  handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] });
  reconcileIncomingToolResults({ sessionKey: input.sessionKey, toolResults: [{ toolUseId: 'call', content: 'result' }] });
  const before = loadCheckpoint(handle.scopeHash, handle.executionId);
  expect(() => beginExecutionTracking({ ...input, executionId: handle.executionId,
    toolResults: [{ toolUseId: 'call', content: 'changed' }] })).toThrow(/different result/i);
  expect(loadCheckpoint(handle.scopeHash, handle.executionId)).toEqual(before);
});

it('rejects a changed result length beyond the digest prefix', () => {
  const handle = beginExecutionTracking(input);
  handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] });
  const content = 'a'.repeat(70_000);
  reconcileIncomingToolResults({ sessionKey: input.sessionKey, toolResults: [{ toolUseId: 'call', content }] });
  const before = loadCheckpoint(handle.scopeHash, handle.executionId);
  expect(() => beginExecutionTracking({ ...input, executionId: handle.executionId,
    toolResults: [{ toolUseId: 'call', content: content + 'changed' }] })).toThrow(/different result/i);
  expect(loadCheckpoint(handle.scopeHash, handle.executionId)).toEqual(before);
});

it.each(['executed', 'not-executed'] as const)('accepts explicit %s confirmation of an emitting call', outcome => {
  const handle = beginExecutionTracking(input);
  const ledger = loadLedger(handle.scopeHash, handle.executionId).value ?? createEmptyLedger(handle.executionId);
  const entry = beginEmitting(planToolCall({ toolCallId: 'call', toolName: 'read' }));
  expect(saveLedgerCAS({ scopeHash: handle.scopeHash, expectedCurrentGeneration: ledger.generation,
    next: withEntry(ledger, entry) }).ok).toBe(true);
  expect(reconcileExecution({ scopeHash: handle.scopeHash, executionId: handle.executionId, toolCallId: 'call', outcome }).ok).toBe(true);
  expect(loadLedger(handle.scopeHash, handle.executionId).value?.entries[0]?.status).toBe(`confirmed_${outcome.replace('-', '_')}`);
});

it('rejects an invalid reconciliation outcome without changing the ledger', () => {
  const handle = beginExecutionTracking(input);
  handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] });
  const before = loadLedger(handle.scopeHash, handle.executionId);
  const outcome = 'mistyped' as Parameters<typeof reconcileExecution>[0]['outcome'];
  expect(reconcileExecution({ scopeHash: handle.scopeHash, executionId: handle.executionId, toolCallId: 'call', outcome }).ok).toBe(false);
  expect(loadLedger(handle.scopeHash, handle.executionId)).toEqual(before);
});
