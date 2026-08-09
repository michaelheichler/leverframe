import { describe, expect, it } from 'vitest';
import { claudeCodeClientModelId } from '../src/context-model-id.js';

describe('claudeCodeClientModelId', () => {
  it('does not add a context suffix when no window was confirmed', () => {
    expect(claudeCodeClientModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('adds the context suffix for a confirmed one-million-token window', () => {
    expect(claudeCodeClientModelId('gpt-5.6-sol', 1_000_000)).toBe('gpt-5.6-sol[1m]');
  });
});
