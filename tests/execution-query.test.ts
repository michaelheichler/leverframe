import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getExecutionDetail, listExecutionSummaries } from '../src/execution-query.js';
import { beginExecutionTracking } from '../src/execution-tracking.js';
import { reconcileExecution } from '../src/execution-recovery.js';
import { ensureExecutionDir } from '../src/checkpoint-store.js';

const originalHome = process.env.LEVERFRAME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

function home(): void {
  process.env.LEVERFRAME_HOME = join(mkdtempSync(join(tmpdir(), 'leverframe-execution-query-')), 'home');
}

describe('execution-query', () => {
  it('reports no executions on an empty store', () => {
    home();
    expect(listExecutionSummaries()).toEqual([]);
  });

  it('summarizes a fresh execution as pending with zero ambiguous tool calls', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const summaries = listExecutionSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      scopeHash: handle.scopeHash,
      executionId: handle.executionId,
      provider: 'anthropic',
      model: 'claude-x',
      status: { kind: 'recovery', decision: 'pending' },
      ambiguousToolCalls: 0,
    });
  });

  it('counts an emitted-but-unresulted tool call as ambiguous in the summary', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-2',
      requestId: 'req-2',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: {} }] });

    const summaries = listExecutionSummaries();
    expect(summaries[0]?.ambiguousToolCalls).toBe(1);

    const detail = getExecutionDetail(handle.scopeHash, handle.executionId);
    expect(detail.found).toBe(true);
    expect(detail.checkpointState).toBe('ok');
    expect(detail.ledgerState).toBe('ok');
    expect(detail.ledgerGeneration).toBeGreaterThan(0);
    expect(detail.ledger?.entries[0]?.status).toBe('emitted');
  });

  it('reflects the recovery decision once reconciled', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-3',
      requestId: 'req-3',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call_2', name: 'bash', input: {} }] });
    const detailBefore = getExecutionDetail(handle.scopeHash, handle.executionId);
    reconcileExecution({
      scopeHash: handle.scopeHash,
      executionId: handle.executionId,
      toolCallId: 'call_2',
      outcome: 'not-executed',
      expectedGeneration: detailBefore.ledgerGeneration,
    });

    const summary = listExecutionSummaries().find(s => s.executionId === handle.executionId);
    expect(summary?.ambiguousToolCalls).toBe(0);
  });

  it('uses a storage status branch when an execution directory has no checkpoint', () => {
    home();
    const scopeHash = 'a'.repeat(32);
    ensureExecutionDir(scopeHash, 'incomplete');
    const summary = listExecutionSummaries().find(item => item.executionId === 'incomplete');
    expect(summary?.status).toEqual({ kind: 'storage', state: 'missing' });
  });

  it('reports found=false and explicit read states for a nonexistent execution', () => {
    home();
    const detail = getExecutionDetail('deadbeef'.repeat(4), 'nonexistent-id');
    expect(detail.found).toBe(false);
    expect(detail.checkpointState).toBe('missing');
    expect(detail.ledgerState).toBe('missing');
    expect(detail.ledgerGeneration).toBe(0);
  });
});
