// src/tool-call-ledger.ts — persistent tool-call ledger with ambiguity
// recovery (stabilization plan §6.4, §8).
//
// Leverframe never executes tools; a client (Claude Code or another caller)
// does, and reports results back in a later request. The ledger is the
// durable record of what Leverframe itself did — planned a call, started
// emitting it, finished emitting it, received a matching result — and
// nothing more. A crash between "emitting" and "result received" leaves the
// client's actual execution status unknown, which this module treats as
// ambiguous rather than guessing: automatic replay/switch is blocked until
// an explicit reconciliation (a matching later result, or an operator
// decision) resolves it.

import {
  ensureExecutionDir,
  getLedgerPath,
  readDocument,
  writeDocumentCAS,
  type CasWriteResult,
  type StoreReadResult,
} from './checkpoint-store.js';
import { boundedDigest, type BoundedDigest } from './execution-checkpoint.js';

export const LEDGER_SCHEMA_VERSION = 1;

export type ToolCallLedgerStatus =
  | 'planned'
  | 'emitting'
  | 'emitted'
  | 'result_received'
  | 'confirmed_executed'
  | 'confirmed_not_executed';

/**
 * Legal forward transitions. `result_received` is evidence (a resend that
 * matches); `confirmed_*` is a decision, reached either automatically once a
 * result is verified or via explicit CLI reconciliation for an ambiguous
 * entry that never produced a result.
 */
const LEGAL_LEDGER_TRANSITIONS: Record<ToolCallLedgerStatus, ReadonlySet<ToolCallLedgerStatus>> = {
  planned: new Set(['emitting', 'confirmed_not_executed']),
  emitting: new Set(['emitted', 'confirmed_not_executed']),
  emitted: new Set(['result_received', 'confirmed_executed', 'confirmed_not_executed']),
  result_received: new Set(['confirmed_executed', 'confirmed_not_executed']),
  confirmed_executed: new Set([]),
  confirmed_not_executed: new Set([]),
};

/** Statuses where a state-changing call may have already reached the client with unknown execution outcome. */
const AMBIGUOUS_STATUSES: ReadonlySet<ToolCallLedgerStatus> = new Set(['emitting', 'emitted']);

export class IllegalLedgerTransitionError extends Error {
  constructor(readonly toolCallId: string, readonly from: ToolCallLedgerStatus, readonly to: ToolCallLedgerStatus) {
    super(`Illegal tool-call ledger transition for ${toolCallId}: ${from} -> ${to}`);
    this.name = 'IllegalLedgerTransitionError';
  }
}

export interface ToolCallLedgerEntry {
  toolCallId: string;
  toolName: string;
  status: ToolCallLedgerStatus;
  argsDigest?: BoundedDigest;
  resultDigest?: BoundedDigest;
  plannedAt?: string;
  emittingAt?: string;
  emittedAt?: string;
  resultReceivedAt?: string;
  confirmedAt?: string;
}

export interface ToolCallLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  generation: number;
  executionId: string;
  entries: ToolCallLedgerEntry[];
  updatedAt: string;
}

const STATUSES: ReadonlySet<ToolCallLedgerStatus> = new Set([
  'planned', 'emitting', 'emitted', 'result_received', 'confirmed_executed', 'confirmed_not_executed',
]);

function isBoundedDigest(value: unknown): value is BoundedDigest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.digest === 'string' && v.digest.length === 64 && typeof v.byteCount === 'number' && v.byteCount >= 0;
}

function isLedgerEntry(value: unknown): value is ToolCallLedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.toolCallId !== 'string' || !v.toolCallId) return false;
  if (typeof v.toolName !== 'string') return false;
  if (typeof v.status !== 'string' || !STATUSES.has(v.status as ToolCallLedgerStatus)) return false;
  if (v.argsDigest !== undefined && !isBoundedDigest(v.argsDigest)) return false;
  if (v.resultDigest !== undefined && !isBoundedDigest(v.resultDigest)) return false;
  return true;
}

export function isSupportedLedger(value: Record<string, unknown>): boolean {
  if (typeof value.executionId !== 'string' || !value.executionId) return false;
  if (!Array.isArray(value.entries) || !value.entries.every(isLedgerEntry)) return false;
  if (typeof value.updatedAt !== 'string') return false;
  return true;
}

export function createEmptyLedger(executionId: string, now: () => number = Date.now): ToolCallLedger {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    generation: 1,
    executionId,
    entries: [],
    updatedAt: new Date(now()).toISOString(),
  };
}

export function loadLedger(scopeHash: string, executionId: string): StoreReadResult<ToolCallLedger> {
  return readDocument(getLedgerPath(scopeHash, executionId), LEDGER_SCHEMA_VERSION, isSupportedLedger, 'tool-call ledger');
}

export interface SaveLedgerCASInput {
  scopeHash: string;
  expectedCurrentGeneration: number;
  next: ToolCallLedger;
}

export function saveLedgerCAS(input: SaveLedgerCASInput): CasWriteResult {
  ensureExecutionDir(input.scopeHash, input.next.executionId);
  return writeDocumentCAS(
    getLedgerPath(input.scopeHash, input.next.executionId),
    LEDGER_SCHEMA_VERSION,
    isSupportedLedger,
    input.expectedCurrentGeneration,
    input.next,
    'tool-call ledger',
  );
}

/** Whether this entry may currently hide a state-changing call the client has not confirmed either way. */
export function isAmbiguousEntry(entry: ToolCallLedgerEntry): boolean {
  return AMBIGUOUS_STATUSES.has(entry.status);
}

export function ambiguousEntries(ledger: ToolCallLedger): ToolCallLedgerEntry[] {
  return ledger.entries.filter(isAmbiguousEntry);
}

function transition(entry: ToolCallLedgerEntry, to: ToolCallLedgerStatus, now: () => number): ToolCallLedgerEntry {
  if (!LEGAL_LEDGER_TRANSITIONS[entry.status].has(to)) {
    throw new IllegalLedgerTransitionError(entry.toolCallId, entry.status, to);
  }
  const at = new Date(now()).toISOString();
  const timestampField: Partial<ToolCallLedgerEntry> = to === 'emitting'
    ? { emittingAt: at }
    : to === 'emitted'
      ? { emittedAt: at }
      : to === 'result_received'
        ? { resultReceivedAt: at }
        : (to === 'confirmed_executed' || to === 'confirmed_not_executed')
          ? { confirmedAt: at }
          : {};
  return { ...entry, ...timestampField, status: to };
}

/** Return a copy of `ledger` with `entry` upserted, advanced to the next generation. */
export function withEntry(ledger: ToolCallLedger, entry: ToolCallLedgerEntry, now: () => number = Date.now): ToolCallLedger {
  const entries = ledger.entries.some(e => e.toolCallId === entry.toolCallId)
    ? ledger.entries.map(e => (e.toolCallId === entry.toolCallId ? entry : e))
    : [...ledger.entries, entry];
  return {
    ...ledger,
    entries,
    generation: ledger.generation + 1,
    updatedAt: new Date(now()).toISOString(),
  };
}

export function findEntry(ledger: ToolCallLedger, toolCallId: string): ToolCallLedgerEntry | undefined {
  return ledger.entries.find(e => e.toolCallId === toolCallId);
}

export interface PlanToolCallInput {
  toolCallId: string;
  toolName: string;
  argsDigest?: BoundedDigest;
}

export function planToolCall(input: PlanToolCallInput, now: () => number = Date.now): ToolCallLedgerEntry {
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: 'planned',
    argsDigest: input.argsDigest,
    plannedAt: new Date(now()).toISOString(),
  };
}

export function beginEmitting(entry: ToolCallLedgerEntry, now: () => number = Date.now): ToolCallLedgerEntry {
  return transition(entry, 'emitting', now);
}

export function markEmitted(entry: ToolCallLedgerEntry, now: () => number = Date.now): ToolCallLedgerEntry {
  return transition(entry, 'emitted', now);
}

/**
 * Record a result the client sent back for `toolCallId`. This is *evidence*
 * only — it does not by itself resolve ambiguity about whether execution
 * happened as reported, so callers still route through {@link confirmExecuted}
 * once the result is accepted as a match (see execution-recovery.ts).
 */
export function recordResult(entry: ToolCallLedgerEntry, resultContent: string, now: () => number = Date.now): ToolCallLedgerEntry {
  return { ...transition(entry, 'result_received', now), resultDigest: boundedDigest(resultContent) };
}

export function confirmExecuted(entry: ToolCallLedgerEntry, now: () => number = Date.now): ToolCallLedgerEntry {
  return transition(entry, 'confirmed_executed', now);
}

/** Reconcile an ambiguous or never-emitted entry as not having executed. Permits a new attempt, never a blind replay of the same call. */
export function confirmNotExecuted(entry: ToolCallLedgerEntry, now: () => number = Date.now): ToolCallLedgerEntry {
  return transition(entry, 'confirmed_not_executed', now);
}
