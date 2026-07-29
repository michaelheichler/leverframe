// src/execution-query.ts — read-only application-level query use case over
// checkpoint-store.ts / execution-checkpoint.ts / tool-call-ledger.ts.
// Returns already-derived view models so presentation layers (the CLI today,
// any future UI) stay limited to argument parsing and rendering rather than
// deriving status/ambiguity themselves.

import { listExecutions } from './checkpoint-store.js';
import { loadCheckpoint, type ExecutionCheckpoint } from './execution-checkpoint.js';
import { ambiguousEntries, loadLedger, type ToolCallLedger } from './tool-call-ledger.js';
import type { StoreReadState } from './checkpoint-store.js';
import type { RecoveryDecisionKind } from './execution-recovery.js';

export type ExecutionStatus =
  | { kind: 'recovery'; decision: RecoveryDecisionKind | 'pending' }
  | { kind: 'storage'; state: StoreReadState };

export interface ExecutionSummaryView {
  scopeHash: string;
  executionId: string;
  provider?: string;
  model?: string;
  status: ExecutionStatus;
  ambiguousToolCalls: number;
}

function summarizeExecution(scopeHash: string, executionId: string): ExecutionSummaryView {
  const checkpoint = loadCheckpoint(scopeHash, executionId);
  const ledger = loadLedger(scopeHash, executionId);
  const ambiguousToolCalls = ledger.state === 'ok' && ledger.value ? ambiguousEntries(ledger.value).length : 0;
  const status: ExecutionStatus = checkpoint.state === 'ok' && checkpoint.value
    ? { kind: 'recovery', decision: checkpoint.value.recoveryDecision ?? 'pending' }
    : { kind: 'storage', state: checkpoint.state };
  return {
    scopeHash,
    executionId,
    provider: checkpoint.value?.provider,
    model: checkpoint.value?.model,
    status,
    ambiguousToolCalls,
  };
}

/** Every execution currently on disk, newest storage state included, for `leverframe executions list`. */
export function listExecutionSummaries(): ExecutionSummaryView[] {
  return listExecutions().map(({ scopeHash, executionId }) => summarizeExecution(scopeHash, executionId));
}

export interface ExecutionDetailView {
  scopeHash: string;
  executionId: string;
  found: boolean;
  checkpointState: StoreReadState;
  checkpoint: ExecutionCheckpoint | null;
  ledgerState: StoreReadState;
  ledger: ToolCallLedger | null;
  /** 0 when the ledger is missing/unreadable; otherwise its current on-disk generation, for CAS-guarded reconciliation. */
  ledgerGeneration: number;
}

/** Full checkpoint + ledger detail for one execution, for `leverframe executions show` and CAS-guarded reconciliation. */
export function getExecutionDetail(scopeHash: string, executionId: string): ExecutionDetailView {
  const checkpoint = loadCheckpoint(scopeHash, executionId);
  const ledger = loadLedger(scopeHash, executionId);
  return {
    scopeHash,
    executionId,
    found: checkpoint.state === 'ok' || ledger.state === 'ok',
    checkpointState: checkpoint.state,
    checkpoint: checkpoint.value ?? null,
    ledgerState: ledger.state,
    ledger: ledger.value ?? null,
    ledgerGeneration: ledger.generation,
  };
}
