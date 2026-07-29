// src/execution-recovery.ts — recovery decision policy and CAS reconciliation
// (stabilization plan §8.3).
//
// Classifies an interrupted execution into exactly one of six outcomes and
// exposes the reconciliation entry point used by both the CLI and the
// authenticated CAS endpoint. A reconstructed continuation is always
// reported as reconstruction — this module never returns `native_resume`
// for anything Leverframe itself stitched back together from preserved
// partial state.

import type { ProviderCapabilityMatrix } from './provider-capabilities.js';
import {
  advanceCheckpoint,
  loadCheckpoint,
  saveCheckpointCAS,
  verifyConversationResend,
  type DigestableMessage,
  type ExecutionCheckpoint,
} from './execution-checkpoint.js';
import {
  ambiguousEntries,
  confirmExecuted,
  confirmNotExecuted,
  findEntry,
  loadLedger,
  saveLedgerCAS,
  withEntry,
  type ToolCallLedger,
  type ToolCallLedgerEntry,
} from './tool-call-ledger.js';
import { isExpired, type StoreReadState } from './checkpoint-store.js';

/**
 * Application-level persistence outcome exposed to recovery callers (CLI,
 * CAS endpoint). This is a deliberate boundary: {@link StoreReadState} is an
 * infrastructure concept (checkpoint-store.ts's on-disk read classification)
 * and must not leak past this module's public surface.
 */
export type PersistenceState = 'ok' | 'not-found' | 'corrupt' | 'unsupported-version' | 'storage-error';

function toPersistenceState(state: StoreReadState): PersistenceState {
  switch (state) {
    case 'ok': return 'ok';
    case 'missing': return 'not-found';
    case 'corrupt': return 'corrupt';
    case 'unsupported-version': return 'unsupported-version';
    case 'invalid-storage': return 'storage-error';
  }
}

export type RecoveryDecisionKind =
  | 'native_resume'
  | 'new_request_with_preserved_state'
  | 'safe_replay'
  | 'continuation_from_partial_text'
  | 'confirmation_required'
  | 'unrecoverable';

export interface RecoveryDecision {
  kind: RecoveryDecisionKind;
  /** Human-readable, secret-free explanation — always precise for `unrecoverable`. */
  reason: string;
  ambiguousToolCallIds: string[];
  /** True only for `continuation_from_partial_text` — callers must label this reconstruction, never transport resume. */
  isReconstruction: boolean;
}

export interface ClassifyRecoveryInput {
  checkpoint: ExecutionCheckpoint;
  ledger: ToolCallLedger;
  capabilities: ProviderCapabilityMatrix;
  /** True when the caller is about to retry against a different provider/model than the checkpoint recorded. */
  providerSwitched: boolean;
  now?: () => number;
}

/**
 * Provider switching always discards any preserved continuation id and
 * signatures (plan §8.3 / §7.4): the caller is responsible for stripping
 * `providerConversationId`/`providerResponseId` before persisting a
 * checkpoint against the new provider. This function additionally refuses
 * to recommend `native_resume` whenever `providerSwitched` is true, even if
 * a stale continuation id is still present on the checkpoint.
 */
function checkpointHasVisibleOutput(checkpoint: ExecutionCheckpoint, ledger: ToolCallLedger): boolean {
  return checkpoint.visibleTextByteCount > 0
    || ledger.entries.some(e => e.status !== 'planned' && e.status !== 'confirmed_not_executed');
}

function classifyNonAmbiguousRecovery(input: ClassifyRecoveryInput): RecoveryDecision {
  if (!input.providerSwitched
    && input.capabilities.nativeResume
    && (input.checkpoint.providerConversationId || input.checkpoint.providerResponseId)) {
    return {
      kind: 'native_resume',
      reason: 'The provider supports native resume and a preserved continuation id is available.',
      ambiguousToolCallIds: [],
      isReconstruction: false,
    };
  }

  if (!checkpointHasVisibleOutput(input.checkpoint, input.ledger)) {
    return {
      kind: 'safe_replay',
      reason: 'No visible output or tool call reached the client; the original request can be replayed unchanged.',
      ambiguousToolCallIds: [],
      isReconstruction: false,
    };
  }

  if (input.capabilities.clientManagedState || (!input.providerSwitched && input.capabilities.conversationContinuation)) {
    return {
      kind: 'new_request_with_preserved_state',
      reason: input.providerSwitched
        ? 'Provider switched after visible output; starting a new attempt seeded from preserved client-managed conversation state.'
        : 'No native resume is available; a new request can be seeded from preserved conversation state.',
      ambiguousToolCallIds: [],
      isReconstruction: false,
    };
  }

  if (input.capabilities.reconstructedRecovery && input.checkpoint.messageDigests.length > 0) {
    return {
      kind: 'continuation_from_partial_text',
      reason: 'Reconstructing a continuation locally from preserved partial text. This is Leverframe-side reconstruction, not a provider-level resume.',
      ambiguousToolCallIds: [],
      isReconstruction: true,
    };
  }

  return {
    kind: 'unrecoverable',
    reason: 'Visible output was already emitted and this provider offers no native resume, conversation continuation, or reconstructable client-managed state.',
    ambiguousToolCallIds: [],
    isReconstruction: false,
  };
}

/**
 * An execution past its checkpoint's `expiresAt` is unrecoverable — except
 * that a still-ambiguous tool call never expires into safety. Confirmation
 * is required first regardless of age; only once every entry is resolved
 * does expiry get to veto replay/reconstruction.
 */
export function classifyRecovery(input: ClassifyRecoveryInput): RecoveryDecision {
  const ambiguous = ambiguousEntries(input.ledger);
  if (ambiguous.length > 0) {
    return {
      kind: 'confirmation_required',
      reason: `${ambiguous.length} tool call(s) were emitted (or partially emitted) with no confirmed client-side execution outcome. Reconcile them before replaying or switching providers.`,
      ambiguousToolCallIds: ambiguous.map(e => e.toolCallId),
      isReconstruction: false,
    };
  }
  if (isExpired(input.checkpoint.expiresAt, input.now)) {
    return {
      kind: 'unrecoverable',
      reason: `Checkpoint expired at ${input.checkpoint.expiresAt}; recovery state is no longer eligible for reuse.`,
      ambiguousToolCallIds: [],
      isReconstruction: false,
    };
  }
  return classifyNonAmbiguousRecovery(input);
}

export interface RestartReconstructionInput {
  checkpoint: ExecutionCheckpoint;
  resentMessages: DigestableMessage[];
}

export interface RestartReconstructionResult {
  ok: boolean;
  /** Always 'reconstructed' on success — restart recovery is never reported as native resume. */
  label: 'reconstructed';
  reason?: string;
}

/**
 * Restart reconstruction (after a Leverframe process restart, with no
 * in-memory state) requires the client to resend its conversation and the
 * resend's digest must match the checkpoint's stored fingerprint before
 * Leverframe will treat the preserved partial state as trustworthy.
 */
export function verifyRestartReconstruction(input: RestartReconstructionInput): RestartReconstructionResult {
  if (!verifyConversationResend(input.checkpoint, input.resentMessages)) {
    return { ok: false, label: 'reconstructed', reason: 'Resent conversation does not match the preserved checkpoint fingerprint; refusing to reconstruct.' };
  }
  return { ok: true, label: 'reconstructed' };
}

export type ReconcileOutcome = 'executed' | 'not-executed';

export interface ReconcileResult {
  ok: boolean;
  state?: PersistenceState;
  error?: string;
  entry?: ToolCallLedgerEntry;
  generation?: number;
}

export interface ReconcileExecutionInput {
  scopeHash: string;
  executionId: string;
  toolCallId: string;
  outcome: ReconcileOutcome;
  /** CAS guard: reject if the ledger has moved past this generation. Omit to reconcile against whatever is current. */
  expectedGeneration?: number;
  now?: () => number;
}

/**
 * The authenticated reconciliation entry point shared by the CLI and the CAS
 * endpoint. `not-executed` clears the ambiguity and permits a new attempt —
 * it never triggers a blind replay of the original call. `executed` records
 * that the client already ran it; any recovery must then wait for (or
 * already have) the matching result rather than emit the call again.
 */
export function reconcileExecution(input: ReconcileExecutionInput): ReconcileResult {
  const now = input.now ?? Date.now;
  const loaded = loadLedger(input.scopeHash, input.executionId);
  if (loaded.state !== 'ok' || !loaded.value) {
    return { ok: false, state: toPersistenceState(loaded.state), error: loaded.error ?? `No ledger found for execution ${input.executionId}` };
  }
  if (input.expectedGeneration !== undefined && loaded.generation !== input.expectedGeneration) {
    return { ok: false, error: `Ledger generation conflict: expected ${input.expectedGeneration}, found ${loaded.generation}` };
  }
  const entry = findEntry(loaded.value, input.toolCallId);
  if (!entry) {
    return { ok: false, error: `No ledger entry for tool call ${input.toolCallId}` };
  }

  const nextEntry = input.outcome === 'executed' ? confirmExecuted(entry, now) : confirmNotExecuted(entry, now);
  const nextLedger = withEntry(loaded.value, nextEntry, now);
  const written = saveLedgerCAS({ scopeHash: input.scopeHash, expectedCurrentGeneration: loaded.generation, next: nextLedger });
  if (!written.ok) {
    return { ok: false, error: written.error ?? `Ledger write conflict (reason: ${written.reason})` };
  }
  return { ok: true, entry: nextEntry, generation: written.generation };
}

export interface ReconcileAllAmbiguousInput {
  scopeHash: string;
  executionId: string;
  outcome: ReconcileOutcome;
  now?: () => number;
}

/** Reconcile every currently-ambiguous entry in one execution's ledger to the same outcome. */
export function reconcileAllAmbiguous(input: ReconcileAllAmbiguousInput): ReconcileResult[] {
  const loaded = loadLedger(input.scopeHash, input.executionId);
  if (loaded.state !== 'ok' || !loaded.value) {
    return [{ ok: false, state: toPersistenceState(loaded.state), error: loaded.error ?? `No ledger found for execution ${input.executionId}` }];
  }
  const targets = ambiguousEntries(loaded.value);
  return targets.map(entry => reconcileExecution({
    scopeHash: input.scopeHash,
    executionId: input.executionId,
    toolCallId: entry.toolCallId,
    outcome: input.outcome,
    now: input.now,
  }));
}

export interface RecordRecoveryDecisionInput {
  scopeHash: string;
  executionId: string;
  decision: RecoveryDecision;
  now?: () => number;
}

/** Persist the classified decision onto the checkpoint so `leverframe executions show` can report it without re-deriving. */
export function recordRecoveryDecision(input: RecordRecoveryDecisionInput): ReconcileResult {
  const loaded = loadCheckpoint(input.scopeHash, input.executionId);
  if (loaded.state !== 'ok' || !loaded.value) {
    return { ok: false, state: toPersistenceState(loaded.state), error: loaded.error ?? `No checkpoint found for execution ${input.executionId}` };
  }
  const next = advanceCheckpoint({
    checkpoint: loaded.value,
    patch: { recoveryDecision: input.decision.kind },
    now: input.now,
  });
  const written = saveCheckpointCAS({ scopeHash: input.scopeHash, expectedCurrentGeneration: loaded.generation, next });
  if (!written.ok) {
    return { ok: false, error: written.error ?? `Checkpoint write conflict (reason: ${written.reason})` };
  }
  return { ok: true, generation: written.generation };
}
