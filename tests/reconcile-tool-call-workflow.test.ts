import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beginExecutionTracking } from '../src/execution-tracking.js';
import { getExecutionDetail } from '../src/execution-query.js';
import { reconcileToolCallWorkflow } from '../src/reconcile-tool-call-workflow.js';

const originalHome = process.env.LEVERFRAME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

function seed(toolIds: string[]) {
  process.env.LEVERFRAME_HOME = join(mkdtempSync(join(tmpdir(), 'leverframe-reconcile-workflow-')), 'home');
  const handle = beginExecutionTracking({
    sessionKey: 'workflow-session',
    requestId: 'request-1',
    provider: 'anthropic',
    model: 'model-1',
    route: 'passthrough',
    messages: [{ role: 'user', content: 'run tools' }],
  });
  for (const id of toolIds) {
    handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id, name: 'bash', input: {} }] });
  }
  return handle;
}

describe('reconcileToolCallWorkflow', () => {
  it('loads the current generation and reconciles one selected call with CAS', () => {
    const handle = seed(['call-1']);
    const result = reconcileToolCallWorkflow({
      scopeHash: handle.scopeHash,
      executionId: handle.executionId,
      selection: { kind: 'one', toolCallId: 'call-1' },
      outcome: 'not-executed',
    });
    expect(result.ok).toBe(true);
    expect(result.results[0]?.entry?.status).toBe('confirmed_not_executed');
  });

  it('reconciles all ambiguous calls through the all selection', () => {
    const handle = seed(['call-1', 'call-2']);
    const result = reconcileToolCallWorkflow({
      scopeHash: handle.scopeHash,
      executionId: handle.executionId,
      selection: { kind: 'all' },
      outcome: 'executed',
    });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every(item => item.entry?.status === 'confirmed_executed')).toBe(true);
  });

  it('returns an application error when the ledger is unavailable', () => {
    process.env.LEVERFRAME_HOME = join(mkdtempSync(join(tmpdir(), 'leverframe-reconcile-workflow-')), 'home');
    const result = reconcileToolCallWorkflow({
      scopeHash: 'a'.repeat(32),
      executionId: 'missing',
      selection: { kind: 'one', toolCallId: 'call-1' },
      outcome: 'executed',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ledger is missing/i);
  });

  it('leaves no ambiguous entries after successful all reconciliation', () => {
    const handle = seed(['call-1']);
    reconcileToolCallWorkflow({
      scopeHash: handle.scopeHash,
      executionId: handle.executionId,
      selection: { kind: 'all' },
      outcome: 'not-executed',
    });
    const detail = getExecutionDetail(handle.scopeHash, handle.executionId);
    expect(detail.ledger?.entries[0]?.status).toBe('confirmed_not_executed');
  });
});
