import { describe, expect, it } from 'vitest';
import { reportedContextWindow } from '../src/context-window.js';
import { formatAnthropicModelEntry } from '../src/server/models.js';

describe('reported context metadata', () => {
  it('returns only a confirmed positive safe integer', () => {
    expect(reportedContextWindow(272_000)).toBe(272_000);
    expect(reportedContextWindow(272_000, true)).toBeUndefined();
    expect(reportedContextWindow(undefined)).toBeUndefined();
    expect(reportedContextWindow(272_000.5)).toBeUndefined();
  });

  it('omits numeric context fields when the provider did not confirm a limit', () => {
    expect(formatAnthropicModelEntry({
      id: 'fresh-model',
      name: 'Fresh Model',
      contextWindowUnconfirmed: true,
    })).toEqual({
      id: 'fresh-model',
      type: 'model',
      display_name: 'Fresh Model',
      created_at: '2025-01-01T00:00:00Z',
    });
  });
});
