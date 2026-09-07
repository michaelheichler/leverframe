import { describe, expect, it } from 'vitest';
import {
  ContextSelectionUnavailableError,
  contextSelectionOptions,
  resolveContextSelection,
} from '../src/context-selection.js';

describe('contextSelectionOptions', () => {
  it('uses the confirmed default and maximum values as two choices', () => {
    expect(contextSelectionOptions({ contextWindow: 272_000, maxContextWindow: 872_000 })).toEqual([
      { mode: 'default', contextWindow: 272_000, label: 'Default (272,000)' },
      { mode: 'maximum', contextWindow: 872_000, label: 'Maximum (872,000)' },
    ]);
  });

  it('keeps one choice when the reported maximum is absent or equal to the default', () => {
    expect(contextSelectionOptions({ contextWindow: 272_000 })).toEqual([
      { mode: 'default', contextWindow: 272_000, label: 'Default (272,000)' },
    ]);
    expect(contextSelectionOptions({ contextWindow: 272_000, maxContextWindow: 272_000 })).toEqual([
      { mode: 'default', contextWindow: 272_000, label: 'Default (272,000)' },
    ]);
  });

  it('does not manufacture a choice for an unconfirmed or missing default', () => {
    expect(contextSelectionOptions({ contextWindow: 272_000, maxContextWindow: 872_000, contextWindowUnconfirmed: true })).toEqual([]);
    expect(contextSelectionOptions({ maxContextWindow: 872_000 })).toEqual([]);
  });
});

describe('resolveContextSelection', () => {
  const metadata = { contextWindow: 272_000, maxContextWindow: 872_000 };

  it('resolves each mode against the supplied metadata', () => {
    expect(resolveContextSelection(metadata, 'default')).toEqual({
      mode: 'default',
      contextWindow: 272_000,
      label: 'Default (272,000)',
    });
    expect(resolveContextSelection(metadata, 'maximum')).toEqual({
      mode: 'maximum',
      contextWindow: 872_000,
      label: 'Maximum (872,000)',
    });
  });

  it('rejects a maximum request when fresh metadata does not report one', () => {
    expect(() => resolveContextSelection({ contextWindow: 272_000 }, 'maximum')).toThrow(ContextSelectionUnavailableError);
  });
});
