import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureExecutionDir,
  getCheckpointPath,
  getExecutionDir,
  getLedgerPath,
  isExpired,
  listExecutions,
  readDocument,
  workspaceOrSessionHash,
} from '../src/checkpoint-store.js';
import {
  advanceCheckpoint,
  createInitialCheckpoint,
  isSupportedCheckpoint,
  loadCheckpoint,
  saveCheckpointCAS,
  verifyConversationResend,
  CHECKPOINT_SCHEMA_VERSION,
} from '../src/execution-checkpoint.js';
import {
  beginEmitting,
  confirmExecuted,
  confirmNotExecuted,
  createEmptyLedger,
  findEntry,
  isAmbiguousEntry,
  loadLedger,
  markEmitted,
  planToolCall,
  recordResult,
  saveLedgerCAS,
  withEntry,
} from '../src/tool-call-ledger.js';
import {
  classifyRecovery,
  reconcileExecution,
  verifyRestartReconstruction,
} from '../src/execution-recovery.js';
import type { ProviderCapabilityMatrix } from '../src/provider-capabilities.js';

const originalHome = process.env.LEVERFRAME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

function home(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'leverframe-executions-')), 'home');
  process.env.LEVERFRAME_HOME = path;
  return path;
}

function capabilities(overrides: Partial<ProviderCapabilityMatrix> = {}): ProviderCapabilityMatrix {
  return {
    streaming: true,
    tools: true,
    images: false,
    reasoning: false,
    promptCache: false,
    websocket: false,
    conversationContinuation: false,
    nativeResume: false,
    reconstructedRecovery: true,
    checkpoints: true,
    idempotencyKeys: false,
    requestStatusLookup: false,
    stableToolCallIds: true,
    serverManagedState: false,
    clientManagedState: true,
    credentialRotation: true,
    source: 'inferred',
    ...overrides,
  };
}

describe('checkpoint-store', () => {
  it('stores executions under a workspace/session hash with 0700 dirs and 0600 files', () => {
    home();
    const scopeHash = workspaceOrSessionHash('/Users/example/project');
    expect(scopeHash).toMatch(/^[0-9a-f]{32}$/);
    ensureExecutionDir(scopeHash, 'exec-1');
    const dir = getExecutionDir(scopeHash, 'exec-1');
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const written = saveCheckpointCAS({ scopeHash, expectedCurrentGeneration: 0, next: checkpoint });
    expect(written.ok).toBe(true);
    expect(statSync(getCheckpointPath(scopeHash, 'exec-1')).mode & 0o777).toBe(0o600);
  });

  it('never persists forbidden secret-shaped fields', () => {
    home();
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-secret',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    (checkpoint as unknown as Record<string, unknown>).apiKey = 'sk-should-not-persist';
    expect(isSupportedCheckpoint(checkpoint as unknown as Record<string, unknown>)).toBe(false);
  });

  it('rejects a CAS write whose generation does not follow the current one', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-2',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    saveCheckpointCAS({ scopeHash, expectedCurrentGeneration: 0, next: checkpoint });

    // Simulate a racing writer that read generation 1 and tries to publish
    // generation 2 while a third writer already advanced to generation 2.
    const loaded = loadCheckpoint(scopeHash, 'exec-2');
    expect(loaded.state).toBe('ok');
    const advanced = advanceCheckpoint({ checkpoint: loaded.value!, patch: { retryCount: 1 } });
    const first = saveCheckpointCAS({ scopeHash, expectedCurrentGeneration: 1, next: advanced });
    expect(first.ok).toBe(true);

    const stale = advanceCheckpoint({ checkpoint: loaded.value!, patch: { retryCount: 99 } });
    const conflict = saveCheckpointCAS({ scopeHash, expectedCurrentGeneration: 1, next: stale });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('conflict');
      expect(conflict.currentGeneration).toBe(2);
    }
  });

  it('classifies missing, corrupt, and unsupported-version documents explicitly', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec-corrupt');
    expect(loadCheckpoint(scopeHash, 'exec-corrupt').state).toBe('missing');

    const path = getCheckpointPath(scopeHash, 'exec-corrupt');
    writeFileSync(path, 'not json', { mode: 0o600 });
    expect(loadCheckpoint(scopeHash, 'exec-corrupt').state).toBe('corrupt');

    writeFileSync(path, JSON.stringify({ schemaVersion: CHECKPOINT_SCHEMA_VERSION + 1, generation: 1 }), { mode: 0o600 });
    expect(loadCheckpoint(scopeHash, 'exec-corrupt').state).toBe('unsupported-version');

    writeFileSync(path, JSON.stringify({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, generation: -1 }), { mode: 0o600 });
    expect(loadCheckpoint(scopeHash, 'exec-corrupt').state).toBe('corrupt');
  });

  it('rejects checkpoint files that are not private-mode 0600', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec-perm');
    const path = getCheckpointPath(scopeHash, 'exec-perm');
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-perm',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    writeFileSync(path, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);
    const result = loadCheckpoint(scopeHash, 'exec-perm');
    expect(result.state).toBe('invalid-storage');
  });

  it('reports executions as expired once past expiresAt', () => {
    expect(isExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isExpired(new Date(Date.now() + 100_000).toISOString())).toBe(false);
    expect(isExpired('not-a-date')).toBe(true);
  });

  it('lists every persisted execution', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec-a');
    ensureExecutionDir(scopeHash, 'exec-b');
    const listed = listExecutions();
    expect(listed).toHaveLength(2);
    expect(listed.map(e => e.executionId).sort()).toEqual(['exec-a', 'exec-b']);
  });

  it('refuses a validate() failure as corrupt even with a matching schema version', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec-bad-fields');
    const path = getCheckpointPath(scopeHash, 'exec-bad-fields');
    writeFileSync(path, JSON.stringify({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, generation: 1 }), { mode: 0o600 });
    const result = readDocument(path, CHECKPOINT_SCHEMA_VERSION, isSupportedCheckpoint, 'checkpoint');
    expect(result.state).toBe('corrupt');
  });
});

describe('tool-call ledger', () => {
  it('tracks the full lifecycle and treats emitting/emitted as ambiguous', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    let ledger = createEmptyLedger('exec-tools');
    const persist = () => {
      const result = saveLedgerCAS({ scopeHash, expectedCurrentGeneration: ledger.generation - 1, next: ledger });
      expect(result.ok).toBe(true);
    };
    persist(); // initial empty ledger: generation 0 -> 1

    const planned = planToolCall({ toolCallId: 'call_1', toolName: 'bash' });
    expect(isAmbiguousEntry(planned)).toBe(false);
    ledger = withEntry(ledger, planned);
    persist();

    const emitting = beginEmitting(planned);
    expect(isAmbiguousEntry(emitting)).toBe(true);
    ledger = withEntry(ledger, emitting);
    persist();

    const emitted = markEmitted(emitting);
    expect(isAmbiguousEntry(emitted)).toBe(true);
    ledger = withEntry(ledger, emitted);
    persist();

    const withResult = recordResult(emitted, 'ok');
    expect(isAmbiguousEntry(withResult)).toBe(false);
    const confirmed = confirmExecuted(withResult);
    expect(confirmed.status).toBe('confirmed_executed');
  });

  it('permits reconciling an emitted-but-unresulted call as not-executed without replaying it', () => {
    const emitted = markEmitted(beginEmitting(planToolCall({ toolCallId: 'call_2', toolName: 'edit' })));
    const notExecuted = confirmNotExecuted(emitted);
    expect(notExecuted.status).toBe('confirmed_not_executed');
    expect(isAmbiguousEntry(notExecuted)).toBe(false);
  });

  it('rejects illegal transitions such as going straight from planned to confirmed_executed', () => {
    const planned = planToolCall({ toolCallId: 'call_3', toolName: 'edit' });
    expect(() => confirmExecuted(planned)).toThrow(/Illegal tool-call ledger transition/);
  });

  it('round-trips through storage with CAS', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    const initial = createEmptyLedger('exec-rt');
    saveLedgerCAS({ scopeHash, expectedCurrentGeneration: 0, next: initial });
    const ledger = withEntry(initial, planToolCall({ toolCallId: 'call_4', toolName: 'read' }));
    const written = saveLedgerCAS({ scopeHash, expectedCurrentGeneration: initial.generation, next: ledger });
    expect(written.ok).toBe(true);
    const loaded = loadLedger(scopeHash, 'exec-rt');
    expect(loaded.state).toBe('ok');
    expect(findEntry(loaded.value!, 'call_4')?.status).toBe('planned');
    expect(getLedgerPath(scopeHash, 'exec-rt')).toContain('exec-rt');
  });
});

describe('execution-recovery', () => {
  it('requires confirmation when an ambiguous tool call is present, before anything else', () => {
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-ambiguous',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const ledger = withEntry(createEmptyLedger('exec-ambiguous'), markEmitted(beginEmitting(planToolCall({ toolCallId: 'call_5', toolName: 'bash' }))));
    const decision = classifyRecovery({ checkpoint, ledger, capabilities: capabilities({ nativeResume: true }), providerSwitched: false });
    expect(decision.kind).toBe('confirmation_required');
    expect(decision.ambiguousToolCallIds).toEqual(['call_5']);
  });

  it('recommends native resume only when unswitched and a continuation id is preserved', () => {
    const checkpoint = {
      ...createInitialCheckpoint({
        executionId: 'exec-resume',
        requestId: 'req-1',
        provider: 'anthropic',
        model: 'claude-x',
        route: 'passthrough',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      providerResponseId: 'resp_123',
    };
    const ledger = createEmptyLedger('exec-resume');
    const resumed = classifyRecovery({ checkpoint, ledger, capabilities: capabilities({ nativeResume: true }), providerSwitched: false });
    expect(resumed.kind).toBe('native_resume');

    const switched = classifyRecovery({ checkpoint, ledger, capabilities: capabilities({ nativeResume: true }), providerSwitched: true });
    expect(switched.kind).not.toBe('native_resume');
  });

  it('allows safe replay before any visible output, and reconstruction (never native resume) after partial text with a switch', () => {
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-replay',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const ledger = createEmptyLedger('exec-replay');
    const beforeOutput = classifyRecovery({ checkpoint, ledger, capabilities: capabilities(), providerSwitched: false });
    expect(beforeOutput.kind).toBe('safe_replay');

    const withText = { ...checkpoint, visibleTextByteCount: 42 };
    const noClientState = classifyRecovery({
      checkpoint: withText,
      ledger,
      capabilities: capabilities({ clientManagedState: false, conversationContinuation: false, reconstructedRecovery: true }),
      providerSwitched: true,
    });
    expect(noClientState.kind).toBe('continuation_from_partial_text');
    expect(noClientState.isReconstruction).toBe(true);
  });

  it('reports unrecoverable with a precise reason when nothing can rebuild state after visible output', () => {
    const checkpoint = {
      ...createInitialCheckpoint({
        executionId: 'exec-unrecoverable',
        requestId: 'req-1',
        provider: 'anthropic',
        model: 'claude-x',
        route: 'passthrough',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      visibleTextByteCount: 10,
      messageDigests: [],
    };
    const decision = classifyRecovery({
      checkpoint,
      ledger: createEmptyLedger('exec-unrecoverable'),
      capabilities: capabilities({ clientManagedState: false, conversationContinuation: false, reconstructedRecovery: false }),
      providerSwitched: false,
    });
    expect(decision.kind).toBe('unrecoverable');
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('verifies restart reconstruction against a resent conversation digest and always labels it reconstructed', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-restart',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages,
    });
    const matching = verifyRestartReconstruction({ checkpoint, resentMessages: messages });
    expect(matching.ok).toBe(true);
    expect(matching.label).toBe('reconstructed');

    const mismatched = verifyRestartReconstruction({ checkpoint, resentMessages: [{ role: 'user', content: 'different' }] });
    expect(mismatched.ok).toBe(false);
    expect(verifyConversationResend(checkpoint, messages)).toBe(true);
  });

  it('reconciles an ambiguous entry as executed or not-executed via CAS, blocking blind replay', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    const initial = createEmptyLedger('exec-reconcile');
    saveLedgerCAS({ scopeHash, expectedCurrentGeneration: 0, next: initial });
    const entry = markEmitted(beginEmitting(planToolCall({ toolCallId: 'call_6', toolName: 'bash' })));
    const ledger = withEntry(initial, entry);
    saveLedgerCAS({ scopeHash, expectedCurrentGeneration: initial.generation, next: ledger });

    const result = reconcileExecution({ scopeHash, executionId: 'exec-reconcile', toolCallId: 'call_6', outcome: 'not-executed' });
    expect(result.ok).toBe(true);
    expect(result.entry?.status).toBe('confirmed_not_executed');

    const reloaded = loadLedger(scopeHash, 'exec-reconcile');
    expect(findEntry(reloaded.value!, 'call_6')?.status).toBe('confirmed_not_executed');

    // A second reconciliation attempt against the stale generation must fail
    // (CAS conflict), rather than silently overwriting the decision.
    const stale = reconcileExecution({ scopeHash, executionId: 'exec-reconcile', toolCallId: 'call_6', outcome: 'executed', expectedGeneration: 1 });
    expect(stale.ok).toBe(false);
  });

  it('fails reconciliation cleanly when no ledger exists for the execution', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    const result = reconcileExecution({ scopeHash, executionId: 'does-not-exist', toolCallId: 'call_x', outcome: 'executed' });
    expect(result.ok).toBe(false);
    expect(result.state).toBe('not-found');
  });
});
