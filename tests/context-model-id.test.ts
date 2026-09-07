import { describe, expect, it } from 'vitest';
import {
  claudeCodeClientModelId,
  contextModeModelId,
  parseContextModeModelId,
  routeLookupIds,
} from '../src/context-model-id.js';

describe('claudeCodeClientModelId', () => {
  it('does not add a context suffix when no window was confirmed', () => {
    expect(claudeCodeClientModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('adds the context suffix for a confirmed one-million-token window', () => {
    expect(claudeCodeClientModelId('gpt-5.6-sol', 1_000_000)).toBe('gpt-5.6-sol[1m]');
  });

  it('encodes maximum context as an internal mode marker without changing the model name', () => {
    expect(contextModeModelId('anthropic-openai__gpt-6-astra', 'maximum'))
      .toBe('anthropic-openai__gpt-6-astra[maximum]');
    expect(contextModeModelId('anthropic-openai__gpt-6-astra[maximum]', 'default'))
      .toBe('anthropic-openai__gpt-6-astra');
    expect(parseContextModeModelId('anthropic-openai__gpt-6-astra[maximum]'))
      .toEqual({ modelId: 'anthropic-openai__gpt-6-astra', mode: 'maximum' });
  });

  it('offers base and mode variants for proxy lookup', () => {
    expect(routeLookupIds('gpt-6-astra[maximum]')).toEqual(expect.arrayContaining([
      'gpt-6-astra[maximum]',
      'gpt-6-astra',
      'gpt-6-astra[default]',
    ]));
  });
});
