

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

  reason: string;
  ambiguousToolCallIds: string[];

  isReconstruction: boolean;
}

export interface ClassifyRecoveryInput {
  checkpoint: ExecutionCheckpoint;
  ledger: ToolCallLedger;
  capabilities: ProviderCapabilityMatrix;

  providerSwitched: boolean;
  now?: () => number;
}

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

  label: 'reconstructed';
  reason?: string;
}

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

  expectedGeneration?: number;
  now?: () => number;
}

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
