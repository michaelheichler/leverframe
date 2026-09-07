

import { randomUUID } from 'node:crypto';
import { isExpired, listExecutions, workspaceOrSessionHash } from './checkpoint-store.js';
import { classifyRecovery, type RecoveryDecision } from './execution-recovery.js';
import { buildProviderCapabilities, type ProviderCapabilityMatrix } from './provider-capabilities.js';
import {
  advanceCheckpoint,
  createInitialCheckpoint,
  loadCheckpoint,
  saveCheckpointCAS,
  type DigestableMessage,
  type ExecutionCheckpoint,
  type ExecutionRoute,
} from './execution-checkpoint.js';
import {
  ambiguousEntries,
  beginEmitting,
  confirmExecuted,
  createEmptyLedger,
  findEntry,
  loadLedger,
  markEmitted,
  planToolCall,
  recordResult,
  saveLedgerCAS,
  withEntry,
  type ToolCallLedger,
} from './tool-call-ledger.js';
import { createAnthropicSseTap, createOpenAiSseTap, observeNonStreamAnthropicResponse, observeNonStreamOpenAiResponse, type ToolCallTap } from './tool-call-tap.js';

export const EXECUTION_ID_HEADER = 'x-leverframe-execution-id';
export const EXECUTION_GENERATION_HEADER = 'x-leverframe-generation';

export interface ExecutionTrackingHandle {
  scopeHash: string;
  executionId: string;

  headers: Record<string, string>;

  observeAnthropicSseText: (chunk: string) => void;

  observeOpenAiSseText: (chunk: string) => void;

  observeNonStreamAnthropic: (parsed: unknown) => void;

  observeNonStreamOpenAi: (parsed: unknown) => void;

  recordRetryAttempt: () => void;

  fail: (category: string | undefined) => void;
}

export interface BeginExecutionTrackingInput {

  sessionKey: string;

  executionId?: string;
  requestId: string;
  correlationId?: string;
  provider: string;
  model: string;
  route: ExecutionRoute;
  messages: DigestableMessage[];
  capabilities?: ProviderCapabilityMatrix;
}

const SAFE_EXECUTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class ExecutionRecoveryBlockedError extends Error {
  readonly statusCode = 409;

  constructor(readonly decision: RecoveryDecision) {
    super(decision.reason);
    this.name = 'ExecutionRecoveryBlockedError';
  }
}

class CheckpointPublisher {
  constructor(private readonly scopeHash: string, private checkpoint: ExecutionCheckpoint, private generation: number) {}

  get current(): ExecutionCheckpoint {
    return this.checkpoint;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  publish(): void {
    const written = saveCheckpointCAS({ scopeHash: this.scopeHash, expectedCurrentGeneration: this.generation, next: this.checkpoint });
    if (!written.ok) throw new Error(written.error ?? `Checkpoint publish failed: ${written.reason}`);
    this.generation = written.generation;
  }

  advance(patch: Parameters<typeof advanceCheckpoint>[0]['patch']): void {
    this.checkpoint = advanceCheckpoint({ checkpoint: this.checkpoint, patch });
    this.publish();
  }
}

class LedgerPublisher {
  constructor(private readonly scopeHash: string, private ledger: ToolCallLedger, private generation: number) {}

  get current(): ToolCallLedger {
    return this.ledger;
  }

  publish(): void {
    const written = saveLedgerCAS({ scopeHash: this.scopeHash, expectedCurrentGeneration: this.generation, next: this.ledger });
    if (!written.ok) throw new Error(written.error ?? `Ledger publish failed: ${written.reason}`);
    this.generation = written.generation;
  }

  upsert(entry: Parameters<typeof withEntry>[1]): void {
    this.ledger = withEntry(this.ledger, entry);
    this.publish();
  }
}

function makeTapCallbacks(checkpoints: CheckpointPublisher, ledger: LedgerPublisher, emitting: Set<string>) {
  return {
    onToolUse: (toolCallId: string, toolName: string) => {
      if (emitting.has(toolCallId)) return;
      emitting.add(toolCallId);

      const planned = planToolCall({ toolCallId, toolName });
      ledger.upsert(planned);
      const emittingEntry = beginEmitting(planned);
      ledger.upsert(emittingEntry);
      ledger.upsert(markEmitted(emittingEntry));
    },
    onTextBytes: (byteCount: number) => {
      checkpoints.advance({ visibleTextByteCount: checkpoints.current.visibleTextByteCount + byteCount });
    },
    onMessageStop: () => {
      checkpoints.advance({ lastConfirmedEvent: 'message_stop' });
    },
  };
}

function openPublishers(input: BeginExecutionTrackingInput, scopeHash: string): {
  executionId: string;
  checkpoints: CheckpointPublisher;
  ledgers: LedgerPublisher;
} {
  if (!input.executionId) {
    const executionId = randomUUID();
    const checkpoint = createInitialCheckpoint({
      executionId,
      requestId: input.requestId,
      correlationId: input.correlationId,
      provider: input.provider,
      model: input.model,
      route: input.route,
      messages: input.messages,
    });
    const checkpoints = new CheckpointPublisher(scopeHash, checkpoint, 0);
    checkpoints.publish();
    const ledgers = new LedgerPublisher(scopeHash, createEmptyLedger(executionId), 0);
    ledgers.publish();
    return { executionId, checkpoints, ledgers };
  }

  if (!SAFE_EXECUTION_ID.test(input.executionId)) throw new Error('Invalid execution id');
  const checkpointRead = loadCheckpoint(scopeHash, input.executionId);
  const ledgerRead = loadLedger(scopeHash, input.executionId);
  if (checkpointRead.state !== 'ok' || !checkpointRead.value) {
    throw new Error(checkpointRead.error ?? `Execution ${input.executionId} checkpoint was not found`);
  }
  if (ledgerRead.state !== 'ok' || !ledgerRead.value) {
    throw new Error(ledgerRead.error ?? `Execution ${input.executionId} ledger was not found`);
  }

  const checkpoints = new CheckpointPublisher(scopeHash, checkpointRead.value, checkpointRead.generation);
  const ledgers = new LedgerPublisher(scopeHash, ledgerRead.value, ledgerRead.generation);
  const providerSwitched = checkpointRead.value.provider !== input.provider || checkpointRead.value.model !== input.model;
  const capabilities = input.capabilities ?? buildProviderCapabilities({
    providerId: input.provider,
    streaming: true,
    tools: true,
    clientManagedState: true,
  });
  const decision = classifyRecovery({
    checkpoint: checkpointRead.value,
    ledger: ledgerRead.value,
    capabilities,
    providerSwitched,
  });
  if (decision.kind === 'confirmation_required' || decision.kind === 'unrecoverable') {
    throw new ExecutionRecoveryBlockedError(decision);
  }
  checkpoints.advance({
    provider: input.provider,
    model: input.model,
    route: input.route,
    recoveryDecision: decision.kind,
    ...(providerSwitched ? { providerConversationId: undefined, providerResponseId: undefined } : {}),
  });
  return { executionId: input.executionId, checkpoints, ledgers };
}

export function beginExecutionTracking(input: BeginExecutionTrackingInput): ExecutionTrackingHandle {
  const scopeHash = workspaceOrSessionHash(input.sessionKey);
  const { executionId, checkpoints, ledgers } = openPublishers(input, scopeHash);
  const emitting = new Set(ledgers.current.entries.map(entry => entry.toolCallId));
  const callbacks = makeTapCallbacks(checkpoints, ledgers, emitting);
  let anthropicTap: ToolCallTap | undefined;
  let openAiTap: ToolCallTap | undefined;
  const headers = {
    [EXECUTION_ID_HEADER]: executionId,
    [EXECUTION_GENERATION_HEADER]: String(checkpoints.currentGeneration),
  };

  return {
    scopeHash,
    executionId,
    headers,
    observeAnthropicSseText: chunk => (anthropicTap ??= createAnthropicSseTap(callbacks)).feed(chunk),
    observeOpenAiSseText: chunk => (openAiTap ??= createOpenAiSseTap(callbacks)).feed(chunk),
    observeNonStreamAnthropic: parsed => observeNonStreamAnthropicResponse(parsed, callbacks),
    observeNonStreamOpenAi: parsed => observeNonStreamOpenAiResponse(parsed, callbacks),
    recordRetryAttempt: () => {
      checkpoints.advance({ retryCount: checkpoints.current.retryCount + 1 });
      headers[EXECUTION_GENERATION_HEADER] = String(checkpoints.currentGeneration);
    },
    fail: category => checkpoints.advance({ failureCategory: category as ExecutionCheckpoint['failureCategory'] }),
  };
}

export interface ToolResultObservation {
  toolUseId: string;
  content: string;
}

export interface ReconcileIncomingResultsInput {
  sessionKey: string;
  toolResults: ToolResultObservation[];
}

export function reconcileIncomingToolResults(input: ReconcileIncomingResultsInput): void {
  if (input.toolResults.length === 0) return;
  const scopeHash = workspaceOrSessionHash(input.sessionKey);
  for (const execution of listExecutions()) {
    if (execution.scopeHash !== scopeHash) continue;
    reconcileExecutionToolResults(scopeHash, execution.executionId, input.toolResults);
  }
}

function reconcileExecutionToolResults(scopeHash: string, executionId: string, toolResults: ToolResultObservation[]): void {
  const loaded = loadLedger(scopeHash, executionId);
  if (loaded.state !== 'ok' || !loaded.value) return;
  const ledgers = new LedgerPublisher(scopeHash, loaded.value, loaded.generation);
  for (const result of toolResults) {
    const entry = findEntry(loaded.value, result.toolUseId);
    if (!entry || entry.status !== 'emitted') continue;
    ledgers.upsert(confirmExecuted(recordResult(entry, result.content)));
  }
}

export interface StartupReconciliationReport {
  scopeHash: string;
  executionId: string;
  ambiguousToolCallIds: string[];
  expired: boolean;
}

export function reconcileExecutionsAtStartup(now: () => number = Date.now): StartupReconciliationReport[] {
  const reports: StartupReconciliationReport[] = [];
  for (const { scopeHash, executionId } of listExecutions()) {
    const checkpoint = loadCheckpoint(scopeHash, executionId);
    const ledger = loadLedger(scopeHash, executionId);
    const expired = checkpoint.state === 'ok' && checkpoint.value ? isExpired(checkpoint.value.expiresAt, now) : false;
    const ambiguousToolCallIds = ledger.state === 'ok' && ledger.value ? ambiguousEntries(ledger.value).map(e => e.toolCallId) : [];
    if (expired || ambiguousToolCallIds.length > 0) {
      reports.push({ scopeHash, executionId, ambiguousToolCallIds, expired });
    }
  }
  return reports;
}
