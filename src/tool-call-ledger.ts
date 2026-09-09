

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

const LEGAL_LEDGER_TRANSITIONS: Record<ToolCallLedgerStatus, ReadonlySet<ToolCallLedgerStatus>> = {
  planned: new Set(['emitting', 'confirmed_not_executed']),
  emitting: new Set(['emitted', 'confirmed_executed', 'confirmed_not_executed']),
  emitted: new Set(['result_received', 'confirmed_executed', 'confirmed_not_executed']),
  result_received: new Set(['confirmed_executed', 'confirmed_not_executed']),
  confirmed_executed: new Set([]),
  confirmed_not_executed: new Set([]),
};

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

export function recordResult(entry: ToolCallLedgerEntry, resultContent: string, now: () => number = Date.now): ToolCallLedgerEntry {
  return { ...transition(entry, 'result_received', now), resultDigest: boundedDigest(resultContent) };
}

export function confirmExecuted(entry: ToolCallLedgerEntry, now: () => number = Date.now): ToolCallLedgerEntry {
  return transition(entry, 'confirmed_executed', now);
}

export function confirmNotExecuted(entry: ToolCallLedgerEntry, now: () => number = Date.now): ToolCallLedgerEntry {
  return transition(entry, 'confirmed_not_executed', now);
}
