import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureExecutionDir, workspaceOrSessionHash } from '../src/checkpoint-store.js';
import { createInitialCheckpoint, type ExecutionCheckpoint } from '../src/execution-checkpoint.js';
import {
  beginEmitting,
  createEmptyLedger,
  markEmitted,
  planToolCall,
  saveLedgerCAS,
  withEntry,
  type ToolCallLedger,
} from '../src/tool-call-ledger.js';
import {
  classifyRecovery,
  reconcileAllAmbiguous,
  reconcileExecution,
  verifyRestartReconstruction,
  type ClassifyRecoveryInput,
} from '../src/execution-recovery.js';
import type { ProviderCapabilityMatrix } from '../src/provider-capabilities.js';

const originalHome = process.env.LEVERFRAME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

function home(): void {
  const path = join(mkdtempSync(join(tmpdir(), 'leverframe-execution-recovery-')), 'home');
  process.env.LEVERFRAME_HOME = path;
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

const messages = [{ role: 'user', content: 'do the thing' }];

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
    reconstructedRecovery: false,
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

function checkpoint(overrides: Partial<ExecutionCheckpoint> = {}): ExecutionCheckpoint {
  return {
    ...createInitialCheckpoint({
      executionId: 'exec-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      route: 'passthrough',
      messages,
    }),
    ...overrides,
  };
}

function baseInput(overrides: Partial<ClassifyRecoveryInput> = {}): ClassifyRecoveryInput {
  return {
    checkpoint: checkpoint(),
    ledger: createEmptyLedger('exec-1'),
    capabilities: capabilities(),
    providerSwitched: false,
    ...overrides,
  };
}

describe('classifyRecovery — the six documented outcomes', () => {
  it('native_resume: provider supports it, a continuation id is preserved, and the provider was not switched', () => {
    const decision = classifyRecovery(baseInput({
      checkpoint: checkpoint({ providerResponseId: 'resp_123', visibleTextByteCount: 10 }),
      capabilities: capabilities({ nativeResume: true }),
    }));
    expect(decision.kind).toBe('native_resume');
    expect(decision.isReconstruction).toBe(false);
  });

  it('safe_replay: nothing visible reached the client yet, regardless of capabilities', () => {
    const decision = classifyRecovery(baseInput({ capabilities: capabilities({ nativeResume: false, clientManagedState: false }) }));
    expect(decision.kind).toBe('safe_replay');
  });

  it('new_request_with_preserved_state: visible output emitted, no native resume, but client-managed state is available', () => {
    const decision = classifyRecovery(baseInput({
      checkpoint: checkpoint({ visibleTextByteCount: 128 }),
      capabilities: capabilities({ nativeResume: false, clientManagedState: true }),
    }));
    expect(decision.kind).toBe('new_request_with_preserved_state');
  });

  it('continuation_from_partial_text: visible output emitted, no continuation path, but local reconstruction is possible — and is labeled as reconstruction, never resume', () => {
    const decision = classifyRecovery(baseInput({
      checkpoint: checkpoint({ visibleTextByteCount: 128 }),
      capabilities: capabilities({ nativeResume: false, clientManagedState: false, conversationContinuation: false, reconstructedRecovery: true }),
    }));
    expect(decision.kind).toBe('continuation_from_partial_text');
    expect(decision.isReconstruction).toBe(true);
    expect(decision.reason.toLowerCase()).toContain('reconstruct');
    expect(decision.reason.toLowerCase()).not.toContain('resume the');
  });

  it('unrecoverable: visible output emitted and no recovery path of any kind is available', () => {
    const decision = classifyRecovery(baseInput({
      checkpoint: checkpoint({ visibleTextByteCount: 128 }),
      capabilities: capabilities({ nativeResume: false, clientManagedState: false, conversationContinuation: false, reconstructedRecovery: false }),
    }));
    expect(decision.kind).toBe('unrecoverable');
  });

  it('confirmation_required: an ambiguous tool call blocks every other decision, even safe_replay-shaped state', () => {
    const ledger = withEntry(createEmptyLedger('exec-1'), markEmitted(beginEmitting(planToolCall({ toolCallId: 'call-1', toolName: 'bash' }))));
    const decision = classifyRecovery(baseInput({ ledger }));
    expect(decision.kind).toBe('confirmation_required');
    expect(decision.ambiguousToolCallIds).toEqual(['call-1']);
  });
});

describe('provider switching', () => {
  it('never recommends native_resume once the provider has switched, even with a preserved continuation id', () => {
    const decision = classifyRecovery(baseInput({
      checkpoint: checkpoint({ providerResponseId: 'resp_123', visibleTextByteCount: 10 }),
      capabilities: capabilities({ nativeResume: true, clientManagedState: true }),
      providerSwitched: true,
    }));
    expect(decision.kind).not.toBe('native_resume');
    expect(decision.kind).toBe('new_request_with_preserved_state');
  });

  it('falls through to safe_replay on a provider switch when nothing visible was emitted', () => {
    const decision = classifyRecovery(baseInput({
      capabilities: capabilities({ nativeResume: true }),
      providerSwitched: true,
    }));
    expect(decision.kind).toBe('safe_replay');
  });
});

describe('expiry', () => {
  it('reports unrecoverable once the checkpoint has expired, even though nothing else was wrong', () => {
    const decision = classifyRecovery(baseInput({
      checkpoint: checkpoint({ expiresAt: '2000-01-01T00:00:00.000Z' }),
      now: () => Date.parse('2024-01-01T00:00:00.000Z'),
    }));
    expect(decision.kind).toBe('unrecoverable');
    expect(decision.reason.toLowerCase()).toContain('expired');
  });

  it('still demands confirmation for an ambiguous tool call before expiry gets a say', () => {
    const ledger = withEntry(createEmptyLedger('exec-1'), beginEmitting(planToolCall({ toolCallId: 'call-1', toolName: 'bash' })));
    const decision = classifyRecovery(baseInput({
      ledger,
      checkpoint: checkpoint({ expiresAt: '2000-01-01T00:00:00.000Z' }),
      now: () => Date.parse('2024-01-01T00:00:00.000Z'),
    }));
    expect(decision.kind).toBe('confirmation_required');
  });
});

describe('restart reconstruction requires a verified client resend', () => {
  it('accepts reconstruction when the resent conversation matches the preserved fingerprint, and always labels it reconstructed', () => {
    const result = verifyRestartReconstruction({ checkpoint: checkpoint(), resentMessages: messages });
    expect(result.ok).toBe(true);
    expect(result.label).toBe('reconstructed');
  });

  it('refuses reconstruction when the resend does not match — no blind trust of a client-asserted history', () => {
    const result = verifyRestartReconstruction({
      checkpoint: checkpoint(),
      resentMessages: [{ role: 'user', content: 'a different conversation entirely' }],
    });
    expect(result.ok).toBe(false);
    expect(result.label).toBe('reconstructed');
  });
});

describe('reconcileExecution — the confirmation endpoint shared by the CLI and the CAS API', () => {
  function seed(ledger: ToolCallLedger): { scopeHash: string; executionId: string } {
    home();
    const scopeHash = workspaceOrSessionHash('workspace-1');
    ensureExecutionDir(scopeHash, ledger.executionId);
    // Publish whatever accumulated in-memory generation as the initial CAS write (0 -> 1):
    // production code only ever increments generation once a document is actually persisted.
    saveLedgerCAS({ scopeHash, expectedCurrentGeneration: 0, next: { ...ledger, generation: 1 } });
    return { scopeHash, executionId: ledger.executionId };
  }

  it('"not-executed" resolves the ambiguity and would permit a new attempt, without touching the original call', () => {
    const ledger = withEntry(createEmptyLedger('exec-1'), markEmitted(beginEmitting(planToolCall({ toolCallId: 'call-1', toolName: 'bash' }))));
    const { scopeHash, executionId } = seed(ledger);

    const result = reconcileExecution({ scopeHash, executionId, toolCallId: 'call-1', outcome: 'not-executed' });
    expect(result.ok).toBe(true);
    expect(result.entry?.status).toBe('confirmed_not_executed');
  });

  it('"executed" records that the client ran it; recovery must wait for the matching result rather than replay', () => {
    const ledger = withEntry(createEmptyLedger('exec-1'), markEmitted(beginEmitting(planToolCall({ toolCallId: 'call-1', toolName: 'bash' }))));
    const { scopeHash, executionId } = seed(ledger);

    const result = reconcileExecution({ scopeHash, executionId, toolCallId: 'call-1', outcome: 'executed' });
    expect(result.ok).toBe(true);
    expect(result.entry?.status).toBe('confirmed_executed');
  });

  it('rejects reconciliation against a stale expected generation (CAS guard) rather than silently reconciling the wrong version', () => {
    const ledger = withEntry(createEmptyLedger('exec-1'), markEmitted(beginEmitting(planToolCall({ toolCallId: 'call-1', toolName: 'bash' }))));
    const { scopeHash, executionId } = seed(ledger);

    const result = reconcileExecution({ scopeHash, executionId, toolCallId: 'call-1', outcome: 'executed', expectedGeneration: 99 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/generation conflict/i);
  });

  it('reports not-found (never a silent success) when no ledger exists for the execution', () => {
    home();
    const scopeHash = workspaceOrSessionHash('workspace-1');
    const result = reconcileExecution({ scopeHash, executionId: 'never-existed', toolCallId: 'call-1', outcome: 'executed' });
    expect(result.ok).toBe(false);
    expect(result.state).toBe('not-found');
  });

  it('reconcileAllAmbiguous resolves every ambiguous entry and leaves already-resolved entries untouched', () => {
    let ledger = createEmptyLedger('exec-1');
    ledger = withEntry(ledger, markEmitted(beginEmitting(planToolCall({ toolCallId: 'ambiguous-1', toolName: 'bash' }))));
    ledger = withEntry(ledger, beginEmitting(planToolCall({ toolCallId: 'ambiguous-2', toolName: 'bash' })));
    ledger = withEntry(ledger, planToolCall({ toolCallId: 'never-emitted', toolName: 'bash' }));
    const { scopeHash, executionId } = seed(ledger);

    const results = reconcileAllAmbiguous({ scopeHash, executionId, outcome: 'not-executed' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.ok)).toBe(true);
  });
});
