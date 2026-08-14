// Privacy-safe Copilot history serialization and rolling prefix hash tests.

import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  type SerializedHistory,
  type SerializedHistoryEntry,
  SERIALIZED_HISTORY_VERSION,
  UnsupportedContentError,
  historyPrefixHashes,
  serializeHistory,
} from '../src/copilot/serialized-history.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TOOL_INPUT_MARKER = { note: 'FAKE-TEST-TOOL-ARGUMENT-NOT-A-SECRET' };

function systemMessage(text: string): ModelMessage {
  return { role: 'system', content: text };
}

function userText(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function assistantText(text: string): ModelMessage {
  return { role: 'assistant', content: text };
}

function assistantReasoning(text: string): ModelMessage {
  return { role: 'assistant', content: [{ type: 'reasoning', text }] };
}

function assistantToolCall(toolCallId: string, toolName: string, input: unknown): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input }] };
}

function toolResultMessage(
  results: ReadonlyArray<{ toolCallId: string; toolName: string; value: string; isError: boolean }>,
): ModelMessage {
  return {
    role: 'tool',
    content: results.map(result => ({
      type: 'tool-result' as const,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      output: {
        type: result.isError ? 'error-text' as const : 'text' as const,
        value: result.value,
      },
    })),
  };
}

function userImageUrl(url: string, mediaType: string | undefined): ModelMessage {
  const part = mediaType === undefined
    ? { type: 'image' as const, image: new URL(url) }
    : { type: 'image' as const, image: new URL(url), mediaType };
  return { role: 'user', content: [part] };
}

function userRawImageData(): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'image', image: 'aGVsbG8=', mediaType: 'image/png' }],
  };
}

function userFileImageUrl(url: string): ModelMessage {
  return {
    role: 'user',
    content: [{
      type: 'file',
      data: new URL(url),
      mediaType: 'image/png',
      filename: 'diagram.png',
    }],
  };
}

function userRemotePdfFile(): ModelMessage {
  return {
    role: 'user',
    content: [{
      type: 'file',
      data: new URL('https://example.com/report.pdf'),
      mediaType: 'application/pdf',
      filename: 'report.pdf',
    }],
  };
}

function userUnsupportedFile(): ModelMessage {
  return {
    role: 'user',
    content: [{
      type: 'file',
      data: 'ZmlsZQ==',
      mediaType: 'application/pdf',
      filename: 'report.pdf',
    }],
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('serializeHistory shape preservation', () => {
  it('stamps the current serialized-history version', () => {
    const history = serializeHistory([userText('hi')]);
    expect(history.version).toBe(SERIALIZED_HISTORY_VERSION);
  });

});

describe('serializeHistory conversation parts', () => {
  it('preserves role, text, reasoning, and tool identifiers', () => {
    const history = serializeHistory([
      systemMessage('be helpful'),
      userText('search for cats'),
      assistantReasoning('the user wants cat facts'),
      assistantToolCall('call-1', 'search', { q: 'cats' }),
      toolResultMessage([{
        toolCallId: 'call-1',
        toolName: 'search',
        value: 'cats are great',
        isError: false,
      }]),
      assistantText('here is what I found'),
    ]);

    expect(history.entries.map((entry: SerializedHistoryEntry) => entry.role)).toEqual([
      'system',
      'user',
      'assistant',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(history.entries[1].parts).toEqual([{ type: 'text', text: 'search for cats' }]);
    expect(history.entries[2].parts).toEqual([{
      type: 'reasoning',
      text: 'the user wants cat facts',
    }]);
    expect(history.entries[3].parts).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'search',
        payloadHash: expect.stringMatching(SHA256_HEX),
      }),
    ]);
    expect(history.entries[4].parts).toEqual([
      expect.objectContaining({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'search',
        status: 'ok',
        payloadHash: expect.stringMatching(SHA256_HEX),
      }),
    ]);
  });

});

describe('serializeHistory tool-result status', () => {
  it('marks an error-text tool result with status error', () => {
    const history = serializeHistory([
      toolResultMessage([{
        toolCallId: 'call-1',
        toolName: 'search',
        value: 'boom',
        isError: true,
      }]),
    ]);
    expect(history.entries[0].parts).toEqual([
      expect.objectContaining({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'search',
        status: 'error',
        payloadHash: expect.stringMatching(SHA256_HEX),
      }),
    ]);
  });


  it('marks execution-denied tool results as errors', () => {
    const message = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'search',
        output: { type: 'execution-denied', reason: 'not approved' },
      }],
    } as ModelMessage;

    expect(serializeHistory([message]).entries[0].parts).toEqual([
      expect.objectContaining({ status: 'error' }),
    ]);
  });
});

describe('serializeHistory image references', () => {
  it('serializes a URL image part', () => {
    const history = serializeHistory([
      userImageUrl('https://example.test/cat.png', 'image/png'),
    ]);
    expect(history.entries[0].parts).toEqual([{
      type: 'image',
      reference: 'https://example.test/cat.png',
      mediaType: 'image/png',
    }]);
  });


  it('rejects URLs that contain credentials, query values, or fragments', () => {
    expect(() => serializeHistory([
      userImageUrl('https://user:password@example.test/cat.png?signature=secret#fragment', 'image/png'),
    ])).toThrow(UnsupportedContentError);
  });

  it('rejects data URL image payloads', () => {
    expect(() => serializeHistory([
      userImageUrl('data:image/png;base64,aGVsbG8=', 'image/png'),
    ])).toThrow(UnsupportedContentError);
  });

  it('defaults a URL image without mediaType to image', () => {
    const history = serializeHistory([
      userImageUrl('https://example.test/cat.png', undefined),
    ]);
    expect(history.entries[0].parts).toEqual([{
      type: 'image',
      reference: 'https://example.test/cat.png',
      mediaType: 'image',
    }]);
  });

  it('rejects remote non-image file URLs', () => {
    expect(() => serializeHistory([{
      role: 'user',
      content: [{
        type: 'file',
        data: new URL('https://example.test/report.pdf'),
        mediaType: 'application/pdf',
        filename: 'report.pdf',
      }],
    }])).toThrow(UnsupportedContentError);
  });

  it('serializes a URL-referenced image file', () => {
    const history = serializeHistory([
      userFileImageUrl('https://example.test/diagram.png'),
    ]);
    expect(history.entries[0].parts).toEqual([{
      type: 'image',
      reference: 'https://example.test/diagram.png',
      mediaType: 'image/png',
    }]);
  });

});

describe('serializeHistory unsupported content', () => {
  it('rejects raw image data instead of dropping it', () => {
    expect(() => serializeHistory([userRawImageData()])).toThrow(UnsupportedContentError);
  });

  it('rejects non-image file attachments instead of dropping them', () => {
    expect(() => serializeHistory([userUnsupportedFile()])).toThrow(UnsupportedContentError);
  });

  it('rejects remote non-image files', () => {
    expect(() => serializeHistory([userRemotePdfFile()])).toThrow(UnsupportedContentError);
  });


  it('rejects malformed message content with a typed error', () => {
    const malformed = { role: 'user', content: null } as unknown as ModelMessage;
    expect(() => serializeHistory([malformed])).toThrow(UnsupportedContentError);
  });

  it('rejects unknown tool-result output shapes', () => {
    const malformed = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'search',
        output: { type: 'future-output', value: 'x' },
      }],
    } as unknown as ModelMessage;
    expect(() => serializeHistory([malformed])).toThrow(UnsupportedContentError);
  });

  it('reports the offending message index', () => {
    try {
      serializeHistory([userText('fine'), userUnsupportedFile()]);
      expect.unreachable('serializeHistory should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedContentError);
      expect((error as UnsupportedContentError).messageIndex).toBe(1);
    }
  });

  it('does not mutate input messages', () => {
    const messages = deepFreeze([
      userText('hello'),
      assistantToolCall('call-1', 'search', TOOL_INPUT_MARKER),
      toolResultMessage([{
        toolCallId: 'call-1',
        toolName: 'search',
        value: 'ok',
        isError: false,
      }]),
    ]);
    const before = JSON.stringify(messages);

    expect(() => serializeHistory(messages)).not.toThrow();
    expect(JSON.stringify(messages)).toBe(before);
  });


  it('accepts empty text and reasoning parts', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '' }] },
    ];

    expect(serializeHistory(messages).entries.map(entry => entry.parts)).toEqual([
      [{ type: 'text', text: '' }],
      [{ type: 'reasoning', text: '' }],
    ]);
  });

  it('supports tagged URL image files', () => {
    const message = {
      role: 'user',
      content: [{
        type: 'file',
        data: { type: 'url', url: new URL('https://example.test/diagram.png') },
        mediaType: 'image/png',
      }],
    } as ModelMessage;

    expect(serializeHistory([message]).entries[0].parts).toEqual([{
      type: 'image',
      reference: 'https://example.test/diagram.png',
      mediaType: 'image/png',
    }]);
  });
});

describe('historyPrefixHashes', () => {
  it('returns one hash per entry plus an empty-prefix seed', () => {
    const history = serializeHistory([userText('a'), assistantText('b'), userText('c')]);
    const chain = historyPrefixHashes(history);
    expect(chain).toHaveLength(4);
    for (const hash of chain) expect(hash).toMatch(SHA256_HEX);
  });

  it('is deterministic for identical content', () => {
    const first = historyPrefixHashes(serializeHistory([userText('a'), assistantText('b')]));
    const second = historyPrefixHashes(serializeHistory([userText('a'), assistantText('b')]));
    expect(first).toEqual(second);
  });

  it('keeps earlier hashes stable when the transcript extends', () => {
    const short = historyPrefixHashes(serializeHistory([userText('a'), assistantText('b')]));
    const long = historyPrefixHashes(serializeHistory([
      userText('a'),
      assistantText('b'),
      userText('c'),
    ]));
    expect(long.slice(0, short.length)).toEqual(short);
  });

  it('changes only hashes at and after an edited entry', () => {
    const original = historyPrefixHashes(serializeHistory([
      userText('a'),
      assistantText('b'),
      userText('c'),
    ]));
    const edited = historyPrefixHashes(serializeHistory([
      userText('a'),
      assistantText('b'),
      userText('DIFFERENT'),
    ]));
    expect(edited.slice(0, 3)).toEqual(original.slice(0, 3));
    expect(edited[3]).not.toBe(original[3]);
  });

  it('mixes the history version into the seed hash', () => {
    const current: SerializedHistory = { version: SERIALIZED_HISTORY_VERSION, entries: [] };
    const next: SerializedHistory = { version: SERIALIZED_HISTORY_VERSION + 1, entries: [] };
    expect(historyPrefixHashes(current)[0]).not.toBe(historyPrefixHashes(next)[0]);
  });
});
