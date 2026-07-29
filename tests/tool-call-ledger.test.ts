import { describe, expect, it } from 'vitest';
import {
  ambiguousEntries,
  beginEmitting,
  confirmExecuted,
  confirmNotExecuted,
  createEmptyLedger,
  findEntry,
  IllegalLedgerTransitionError,
  isAmbiguousEntry,
  isSupportedLedger,
  markEmitted,
  planToolCall,
  recordResult,
  withEntry,
} from '../src/tool-call-ledger.js';

describe('legal transitions', () => {
  it('walks planned -> emitting -> emitted -> result_received -> confirmed_executed', () => {
    let entry = planToolCall({ toolCallId: 'call-1', toolName: 'bash' });
    expect(entry.status).toBe('planned');
    entry = beginEmitting(entry);
    expect(entry.status).toBe('emitting');
    entry = markEmitted(entry);
    expect(entry.status).toBe('emitted');
    entry = recordResult(entry, 'exit 0');
    expect(entry.status).toBe('result_received');
    expect(entry.resultDigest?.digest).toMatch(/^[0-9a-f]{64}$/);
    entry = confirmExecuted(entry);
    expect(entry.status).toBe('confirmed_executed');
  });

  it('rejects an illegal transition, e.g. confirmed back to planned or skipping straight from planned to result_received', () => {
    const confirmed = confirmExecuted(markEmitted(beginEmitting(planToolCall({ toolCallId: 'c', toolName: 't' }))));
    expect(() => beginEmitting(confirmed)).toThrow(IllegalLedgerTransitionError);

    const planned = planToolCall({ toolCallId: 'c2', toolName: 't' });
    expect(() => recordResult(planned, 'x')).toThrow(IllegalLedgerTransitionError);
  });

  it('allows a never-emitted planned entry to resolve straight to confirmed_not_executed', () => {
    const planned = planToolCall({ toolCallId: 'c3', toolName: 't' });
    const resolved = confirmNotExecuted(planned);
    expect(resolved.status).toBe('confirmed_not_executed');
  });
});

describe('ambiguity — the crash-boundary safety property', () => {
  it('flags "emitting" and "emitted" as ambiguous (a state-changing call may have reached the client)', () => {
    const emitting = beginEmitting(planToolCall({ toolCallId: 'c', toolName: 't' }));
    const emitted = markEmitted(emitting);
    expect(isAmbiguousEntry(emitting)).toBe(true);
    expect(isAmbiguousEntry(emitted)).toBe(true);
  });

  it('does not flag "planned" as ambiguous — nothing left the process yet, so it is safe to discard or replay', () => {
    const planned = planToolCall({ toolCallId: 'c', toolName: 't' });
    expect(isAmbiguousEntry(planned)).toBe(false);
  });

  it('does not flag resolved states (result_received, confirmed_*) as ambiguous', () => {
    const withResult = recordResult(markEmitted(beginEmitting(planToolCall({ toolCallId: 'c', toolName: 't' }))), 'ok');
    expect(isAmbiguousEntry(withResult)).toBe(false);
    expect(isAmbiguousEntry(confirmExecuted(withResult))).toBe(false);
    expect(isAmbiguousEntry(confirmNotExecuted(planToolCall({ toolCallId: 'd', toolName: 't' })))).toBe(false);
  });

  it('ambiguousEntries surfaces every currently-ambiguous entry in a ledger', () => {
    let ledger = createEmptyLedger('exec-1');
    ledger = withEntry(ledger, planToolCall({ toolCallId: 'safe', toolName: 't' }));
    ledger = withEntry(ledger, markEmitted(beginEmitting(planToolCall({ toolCallId: 'ambiguous-1', toolName: 't' }))));
    ledger = withEntry(ledger, beginEmitting(planToolCall({ toolCallId: 'ambiguous-2', toolName: 't' })));
    const ambiguous = ambiguousEntries(ledger);
    expect(ambiguous.map(e => e.toolCallId).sort()).toEqual(['ambiguous-1', 'ambiguous-2']);
  });
});

describe('duplicate tool-call ids', () => {
  it('withEntry upserts by toolCallId rather than appending a duplicate row', () => {
    let ledger = createEmptyLedger('exec-1');
    const first = planToolCall({ toolCallId: 'dup', toolName: 't' });
    ledger = withEntry(ledger, first);
    expect(ledger.entries).toHaveLength(1);

    const advanced = markEmitted(beginEmitting(findEntry(ledger, 'dup')!));
    ledger = withEntry(ledger, advanced);
    expect(ledger.entries).toHaveLength(1);
    expect(findEntry(ledger, 'dup')?.status).toBe('emitted');
  });

  it('withEntry advances the ledger generation on every write', () => {
    const ledger = createEmptyLedger('exec-1');
    const next = withEntry(ledger, planToolCall({ toolCallId: 'a', toolName: 't' }));
    expect(next.generation).toBe(ledger.generation + 1);
  });
});

describe('late result reconciliation', () => {
  it('a result arriving after emission moves the entry to result_received and preserves only a digest of the payload', () => {
    const emitted = markEmitted(beginEmitting(planToolCall({ toolCallId: 'late', toolName: 'read_file' })));
    const withResult = recordResult(emitted, JSON.stringify({ contents: 'file body that must never be persisted verbatim' }));
    expect(withResult.status).toBe('result_received');
    expect(isAmbiguousEntry(withResult)).toBe(false);
    expect(JSON.stringify(withResult)).not.toContain('file body');
  });
});

describe('schema validation', () => {
  it('accepts a well-formed empty ledger', () => {
    const ledger = createEmptyLedger('exec-1');
    expect(isSupportedLedger(ledger as unknown as Record<string, unknown>)).toBe(true);
  });

  it('rejects an entry with an unknown status', () => {
    const ledger = withEntry(createEmptyLedger('exec-1'), planToolCall({ toolCallId: 'a', toolName: 't' }));
    const poisoned = { ...ledger, entries: [{ ...ledger.entries[0], status: 'not-a-real-status' }] };
    expect(isSupportedLedger(poisoned as unknown as Record<string, unknown>)).toBe(false);
  });
});
