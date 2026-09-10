import { describe, expect, it } from 'vitest';
import { translateOpenAiRequest, type OpenAiMessage } from '../src/openai-request-translation.js';

describe('OpenAI conversation preservation', () => {
  it.each(['system', 'developer'] as const)('preserves leading and inline %s text arrays', role => {
    const messages = [
      { role, content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] },
      { role: 'user', content: 'Question' },
      { role, content: [{ type: 'text', text: 'Later' }] },
    ] as OpenAiMessage[];
    const result = translateOpenAiRequest({ model: 'test', messages });
    expect(result.instructions).toBe('First\nSecond');
    expect(result.messages).toEqual([
      { role: 'user', content: 'Question' }, { role: 'system', content: 'Later' },
    ]);
  });

  it('preserves assistant text parts before its tool calls', () => {
    const result = translateOpenAiRequest({ model: 'test', messages: [{
      role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'text', text: ' now' }],
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }],
    }] });
    expect(result.messages[0]).toEqual({ role: 'assistant', content: [
      { type: 'text', text: 'Checking' }, { type: 'text', text: ' now' },
      { type: 'tool-call', toolCallId: 'call', toolName: 'read', input: {} },
    ] });
  });

  it('keeps prototype-like names as own tool definitions', () => {
    const result = translateOpenAiRequest({ model: 'test', messages: [], tools: [
      { type: 'function', function: { name: '__proto__' } },
    ] });
    expect(Object.keys(result.tools ?? {})).toEqual(['__proto__']);
    expect(Object.hasOwn(result.tools ?? {}, '__proto__')).toBe(true);
  });
});
