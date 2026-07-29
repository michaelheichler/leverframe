import { getExecutionDetail } from './execution-query.js';
import {
  reconcileAllAmbiguous,
  reconcileExecution,
  type ReconcileOutcome,
  type ReconcileResult,
} from './execution-recovery.js';

export type ToolCallSelection =
  | { kind: 'all' }
  | { kind: 'one'; toolCallId: string };

export interface ReconcileToolCallWorkflowInput {
  scopeHash: string;
  executionId: string;
  selection: ToolCallSelection;
  outcome: ReconcileOutcome;
}

export interface ReconcileToolCallWorkflowResult {
  ok: boolean;
  results: ReconcileResult[];
  error?: string;
}

/**
 * Application use case shared by CLI/API presentation layers. It owns ledger
 * availability checks and the generation read used for the one-entry CAS, so
 * callers only parse intent and render the result.
 */
export function reconcileToolCallWorkflow(input: ReconcileToolCallWorkflowInput): ReconcileToolCallWorkflowResult {
  if (input.selection.kind === 'all') {
    const results = reconcileAllAmbiguous({
      scopeHash: input.scopeHash,
      executionId: input.executionId,
      outcome: input.outcome,
    });
    return { ok: results.every(result => result.ok), results };
  }

  if (!input.selection.toolCallId.trim()) {
    return { ok: false, results: [], error: 'Tool-call id must not be empty.' };
  }
  const detail = getExecutionDetail(input.scopeHash, input.executionId);
  if (detail.ledgerState !== 'ok') {
    return { ok: false, results: [], error: `Ledger is ${detail.ledgerState}.` };
  }
  const result = reconcileExecution({
    scopeHash: input.scopeHash,
    executionId: input.executionId,
    toolCallId: input.selection.toolCallId,
    outcome: input.outcome,
    expectedGeneration: detail.ledgerGeneration,
  });
  return {
    ok: result.ok,
    results: [result],
    ...(!result.ok ? { error: result.error ?? 'Reconciliation failed.' } : {}),
  };
}
