import { describe, it, expect } from 'vitest';
import {
  annotateToolNames,
  translateMessages,
  translateTools,
  positiveEnvMs,
  supportsOpenAiPromptCacheBreakpoints,
  sdkTranslationErrorSignature,
  ToolResultImageError,
} from '../src/sdk-adapter.js';

describe('positiveEnvMs', () => {
  it.each([
    ['42', 42],
    [' 42 ', 42],
    ['10abc', 10_000],
    ['0x10', 10_000],
    ['-5', 10_000],
    ['', 10_000],
  ])('parses %s strictly', (raw, expected) => {
    const previous = process.env.LEVERFRAME_TEST_TIMEOUT_MS;
    process.env.LEVERFRAME_TEST_TIMEOUT_MS = raw;
    expect(positiveEnvMs('LEVERFRAME_TEST_TIMEOUT_MS', 10_000)).toBe(expected);
    if (previous === undefined) delete process.env.LEVERFRAME_TEST_TIMEOUT_MS;
    else process.env.LEVERFRAME_TEST_TIMEOUT_MS = previous;
  });
});

describe('sdkTranslationErrorSignature', () => {
  it('classifies missing stream parts without exposing their dynamic ids', () => {
    expect(sdkTranslationErrorSignature(new Error('reasoning part reasoning-42 not found')))
      .toBe('reasoning_part_not_found');
    expect(sdkTranslationErrorSignature('text part msg-sensitive not found'))
      .toBe('text_part_not_found');
    expect(sdkTranslationErrorSignature(new Error('rate limited'))).toBeUndefined();
  });
});

describe('supportsOpenAiPromptCacheBreakpoints', () => {
  it('uses the reported capability and does not inspect model ids', () => {
    expect(supportsOpenAiPromptCacheBreakpoints('gpt-5.5')).toBe(false);
    expect(supportsOpenAiPromptCacheBreakpoints('gpt-5.6-sol', true)).toBe(true);
    expect(supportsOpenAiPromptCacheBreakpoints('gpt-5.10', false)).toBe(false);
    expect(supportsOpenAiPromptCacheBreakpoints('gpt-6')).toBe(false);
    expect(supportsOpenAiPromptCacheBreakpoints('grok-5.6', true)).toBe(true);
  });
});

describe('translateTools', () => {
  it('builds client-side tools (no execute) keyed by name', () => {
    const tools = translateTools([
      { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);
    expect(tools && Object.keys(tools)).toEqual(['Read']);
    expect(tools!.Read.execute).toBeUndefined();
  });
  it('returns undefined for empty/missing tools', () => {
    expect(translateTools(undefined)).toBeUndefined();
    expect(translateTools([])).toBeUndefined();
  });
});

describe('annotateToolNames', () => {
  it('resolves tool_result names from prior tool_use ids', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hi' }] },
    ];
    annotateToolNames(messages);
    expect((messages[1].content as any[])[0]._name).toBe('Read');
  });
  it('resolves names even when the id carries an encoded thought signature', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'call_1__ts__U0lH', name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call_1__ts__U0lH', content: 'hi' }] },
    ];
    annotateToolNames(messages);
    expect((messages[1].content as any[])[0]._name).toBe('Read');
  });
});

describe('translateMessages', () => {
  it('maps user text and assistant text', () => {
    const out = translateMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ], '@ai-sdk/xai');
    expect(out).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ]);
  });

  it('maps tool_use → tool-call and tool_result → tool message', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }] },
    ];
    annotateToolNames(messages);
    const out = translateMessages(messages, '@ai-sdk/xai') as any[];
    expect(out[0]).toEqual({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: { path: 'a' } }] });
    expect(out[1]).toEqual({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'Read', output: { type: 'text', value: 'file body' } }] });
  });

  it('lifts tool_result images into a following user message instead of inlining base64', () => {
    const data = Buffer.from('fake-png-bytes').toString('base64');
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'shot.png' } }] },
      { role: 'user' as const, content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [
          { type: 'text', text: 'rendered 1 page' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        ] },
        { type: 'text', text: 'continue' },
      ] },
    ];
    annotateToolNames(messages);
    const out = translateMessages(messages, '@ai-sdk/openai') as any[];

    expect(out[1].role).toBe('tool');
    const value = out[1].content[0].output.value as string;
    expect(value).not.toContain(data);
    expect(value).toContain('rendered 1 page');
    expect(value).toContain('attached');

    expect(out[2].role).toBe('user');
    expect(out[2].content[0]).toEqual({ type: 'text', text: expect.stringContaining('call_1') });
    expect(out[2].content[1]).toEqual({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'data', data: Buffer.from(data, 'base64') },
    });
    expect(out[2].content[2]).toEqual({ type: 'text', text: 'continue' });
  });

  it.each([
    ['unsupported media type', { type: 'base64', media_type: 'application/pdf', data: 'aGk=' }, 'unsupported_media_type'],
    ['malformed base64', { type: 'base64', media_type: 'image/png', data: 'not base64!' }, 'malformed_base64'],
  ])('rejects %s tool-result images without exposing their payload', (_label, source, code) => {
    const messages = [{
      role: 'user' as const,
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_invalid',
        content: [{ type: 'image', source }],
      }],
    }];

    try {
      translateMessages(messages, '@ai-sdk/openai');
      throw new Error('expected invalid tool-result image');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ToolResultImageError',
        code,
      });
      expect(ToolResultImageError.isInstance(error)).toBe(true);
      expect(String(error)).not.toContain(source.data);
    }
  });

  it('does not duplicate a large image payload into tool-result text', () => {
    const data = 'A'.repeat(400_000);
    const out = translateMessages([{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_large',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data },
        }],
      }],
    }], '@ai-sdk/openai');

    expect(JSON.stringify(out)).not.toContain(data);
  });

  it('decodes thought_signature into providerOptions for Google only', () => {
    const msg = [{ role: 'assistant' as const, content: [
      { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
      { type: 'tool_use', id: 'call_1__ts__VFNJRw', name: 'Read', input: {} },
    ] }];
    const google = translateMessages(msg, '@ai-sdk/google') as any[];
    expect(google[0].content[0].providerOptions).toEqual({ google: { thoughtSignature: 'SIG' } });
    expect(google[0].content[1].providerOptions).toEqual({ google: { thoughtSignature: 'TSIG' } });

    const xai = translateMessages(msg, '@ai-sdk/xai') as any[];
    expect(xai[0].content).toHaveLength(2);
    expect(xai[0].content[0]).toEqual({ type: 'reasoning', text: 'hmm' });
    expect(xai[0].content[1]).toEqual({ type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: {} });
  });

  it('round-trips OpenAI reasoningEncryptedContent via thinking.signature', () => {
    const msg = [{ role: 'assistant' as const, content: [
      { type: 'thinking', thinking: 'chain...', signature: 'enc_blob_abc' },
    ] }];
    const openai = translateMessages(msg, '@ai-sdk/openai') as any[];
    expect(openai[0].content[0]).toEqual({
      type: 'reasoning',
      text: 'chain...',
      providerOptions: { openai: { reasoningEncryptedContent: 'enc_blob_abc' } },
    });
  });

  it('drops empty OpenAI thinking blocks without encrypted content', () => {
    const msg = [{ role: 'assistant' as const, content: [
      { type: 'thinking', thinking: '', signature: '' },
      { type: 'text', text: 'hello' },
    ] }];
    const openai = translateMessages(msg, '@ai-sdk/openai') as any[];
    expect(openai[0].content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('maps base64 image blocks to AI SDK 7 file parts', () => {
    const out = translateMessages([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] },
    ], '@ai-sdk/google') as any[];
    expect(out[0].content[0].type).toBe('file');
    expect(out[0].content[0].mediaType).toBe('image/png');
    expect(out[0].content[0].data.type).toBe('data');
    expect(Buffer.isBuffer(out[0].content[0].data.data)).toBe(true);
  });
});
