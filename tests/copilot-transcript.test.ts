// Deterministic Copilot session key and transcript classification tests.

import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { serializeHistory } from '../src/copilot/serialized-history.js';
import {
  type CopilotToolSchema,
  type TranscriptComparisonState,
  classifyTranscript,
  hashSystemPrompt,
  hashToolSchema,
} from '../src/copilot/transcript.js';

const TOOL_INPUT_MARKER = { note: 'FAKE-TEST-TOOL-ARGUMENT-NOT-A-SECRET' };
const PROMPT_TEXT_MARKER = 'SECRET-PROMPT-MARKER-DO-NOT-LEAK';

function userText(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function assistantText(text: string): ModelMessage {
  return { role: 'assistant', content: text };
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const BASE_TOOLS: readonly CopilotToolSchema[] = [
  {
    name: 'search',
    description: 'Search the web',
    inputSchemaJson: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  {
    name: 'fetch',
    description: 'Fetch a URL',
    inputSchemaJson: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
];

function baseState(messages: readonly ModelMessage[]): TranscriptComparisonState {
  return {
    upstreamModel: 'gpt-5-copilot',
    reasoningEffort: null,
    systemPromptHash: hashSystemPrompt('be a helpful coding assistant'),
    toolSchemaHash: hashToolSchema(BASE_TOOLS),
    history: serializeHistory(messages),
  };
}

describe('classifyTranscript: cold restart', () => {
  it('resyncs with reason "cold-restart" when there is no prior state', () => {
    const current = baseState([userText('hello')]);
    expect(classifyTranscript(null, current)).toEqual({ kind: 'resync', reason: 'cold-restart' });
  });
});

describe('classifyTranscript: extension and retry', () => {
  const priorMessages = [userText('turn 1'), assistantText('reply 1')];
  const prior = baseState(priorMessages);

  it('classifies a plain appended user turn as "new-turn"', () => {
    const current = baseState([...priorMessages, userText('turn 2')]);
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'new-turn' });
  });

  it('classifies a byte-identical resend as "exact-retry"', () => {
    const current = baseState([userText('turn 1'), assistantText('reply 1')]);
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'exact-retry' });
  });


  it('resyncs when a tool call keeps its ID but changes input', () => {
    const prior = baseState([
      userText('read a file'),
      assistantToolCall('call-1', 'Read', { path: 'first.txt' }),
    ]);
    const current = baseState([
      userText('read a file'),
      assistantToolCall('call-1', 'Read', { path: 'second.txt' }),
    ]);

    expect(classifyTranscript(prior, current)).toEqual({ kind: 'resync', reason: 'branch' });
  });

  it('resyncs when a tool result keeps its ID but changes output', () => {
    const before = [
      userText('read a file'),
      assistantToolCall('call-1', 'Read', { path: 'file.txt' }),
    ];
    const prior = baseState([
      ...before,
      toolResultMessage([{ toolCallId: 'call-1', toolName: 'Read', value: 'first', isError: false }]),
    ]);
    const current = baseState([
      ...before,
      toolResultMessage([{ toolCallId: 'call-1', toolName: 'Read', value: 'second', isError: false }]),
    ]);

    expect(classifyTranscript(prior, current)).toEqual({ kind: 'resync', reason: 'branch' });
  });
});

describe('classifyTranscript: tool-result continuation', () => {
  it('resolves a single pending tool call', () => {
    const priorMessages = [userText('search for cats'), assistantToolCall('call-1', 'search', { q: 'cats' })];
    const prior = baseState(priorMessages);
    const current = baseState([
      ...priorMessages,
      toolResultMessage([{ toolCallId: 'call-1', toolName: 'search', value: 'cats', isError: false }]),
    ]);
    expect(classifyTranscript(prior, current)).toEqual({
      kind: 'tool-result-continuation',
      resolvedToolCallIds: ['call-1'],
    });
  });

  it('resolves parallel tool calls carried in a single tool message', () => {
    const priorMessages = [
      userText('search and fetch'),
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool-call' as const, toolCallId: 'call-a', toolName: 'search', input: { q: 'cats' } },
          { type: 'tool-call' as const, toolCallId: 'call-b', toolName: 'fetch', input: { url: 'https://example.test' } },
        ],
      },
    ];
    const prior = baseState(priorMessages);
    const current = baseState([
      ...priorMessages,
      toolResultMessage([
        { toolCallId: 'call-a', toolName: 'search', value: 'cats', isError: false },
        { toolCallId: 'call-b', toolName: 'fetch', value: 'page', isError: false },
      ]),
    ]);
    expect(classifyTranscript(prior, current)).toEqual({
      kind: 'tool-result-continuation',
      resolvedToolCallIds: ['call-a', 'call-b'],
    });
  });
});

describe('classifyTranscript: tool-result continuation ordering and errors', () => {
  it('preserves transcript order for out-of-order results across separate tool messages', () => {
    const priorMessages = [
      userText('search and fetch'),
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool-call' as const, toolCallId: 'call-a', toolName: 'search', input: { q: 'cats' } },
          { type: 'tool-call' as const, toolCallId: 'call-b', toolName: 'fetch', input: { url: 'https://example.test' } },
        ],
      },
    ];
    const prior = baseState(priorMessages);
    const current = baseState([
      ...priorMessages,
      toolResultMessage([{ toolCallId: 'call-b', toolName: 'fetch', value: 'page', isError: false }]),
      toolResultMessage([{ toolCallId: 'call-a', toolName: 'search', value: 'cats', isError: false }]),
    ]);
    expect(classifyTranscript(prior, current)).toEqual({
      kind: 'tool-result-continuation',
      resolvedToolCallIds: ['call-b', 'call-a'],
    });
  });

  it('carries an error tool result through as a resolved id, same as a successful one', () => {
    const priorMessages = [userText('search for cats'), assistantToolCall('call-1', 'search', { q: 'cats' })];
    const prior = baseState(priorMessages);
    const current = baseState([
      ...priorMessages,
      toolResultMessage([{ toolCallId: 'call-1', toolName: 'search', value: 'boom', isError: true }]),
    ]);
    expect(classifyTranscript(prior, current)).toEqual({
      kind: 'tool-result-continuation',
      resolvedToolCallIds: ['call-1'],
    });
  });
});

describe('classifyTranscript: compaction, rewind, and branch', () => {
  const priorMessages = [
    userText('turn 1'),
    assistantText('reply 1'),
    userText('turn 2'),
    assistantText('reply 2'),
  ];
  const prior = baseState(priorMessages);

  it('resyncs with reason "rewind" when the new history is an exact, shorter prefix', () => {
    const current = baseState(priorMessages.slice(0, 2));
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'resync', reason: 'rewind' });
  });

  it('resyncs with reason "compaction" when the new, shorter history has different content', () => {
    const current = baseState([userText('[summary of earlier conversation]'), assistantText('reply 2')]);
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'resync', reason: 'compaction' });
  });

  it('resyncs with reason "branch" when a same-length history diverges before the end', () => {
    const current = baseState([
      priorMessages[0],
      priorMessages[1],
      userText('turn 2 EDITED'),
      assistantText('reply 2 EDITED'),
    ]);
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'resync', reason: 'branch' });
  });

  it('resyncs with reason "branch" when a longer history diverges before the shared prefix ends', () => {
    const current = baseState([
      priorMessages[0],
      priorMessages[1],
      userText('turn 2 EDITED'),
      assistantText('reply 2 EDITED'),
      userText('turn 3'),
    ]);
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'resync', reason: 'branch' });
  });
});

describe('classifyTranscript: session-key component changes force resync', () => {
  const messages = [userText('turn 1'), assistantText('reply 1')];
  const prior = baseState(messages);

  it.each([
    ['upstream model', { ...baseState(messages), upstreamModel: 'gpt-5-copilot-mini' }, 'model-changed'],
    ['reasoning effort', { ...baseState(messages), reasoningEffort: 'high' }, 'model-changed'],
    [
      'tool schema',
      { ...baseState(messages), toolSchemaHash: hashToolSchema([BASE_TOOLS[0]]) },
      'tool-schema-changed',
    ],
    [
      'system prompt',
      { ...baseState(messages), systemPromptHash: hashSystemPrompt('a different system prompt') },
      'system-prompt-changed',
    ],
  ] as const)('resyncs with reason "%s" -> %s', (_label, current, expectedReason) => {
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'resync', reason: expectedReason });
  });

  it('gives model-changed priority over a diverged history when both change at once', () => {
    const current: TranscriptComparisonState = {
      ...baseState([userText('completely different conversation')]),
      upstreamModel: 'gpt-5-copilot-mini',
    };
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'resync', reason: 'model-changed' });
  });
});

describe('classifyTranscript: privacy-safe diagnostics', () => {
  it('never includes prompt text or tool-call input in a resync decision', () => {
    const priorMessages = [userText('turn 1'), assistantText('reply 1')];
    const prior = baseState(priorMessages);
    const current = baseState([
      userText(PROMPT_TEXT_MARKER),
      assistantToolCall('call-1', 'search', TOOL_INPUT_MARKER),
    ]);

    const decision = classifyTranscript(prior, current);
    expect(decision.kind).toBe('resync');

    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain(PROMPT_TEXT_MARKER);
    expect(serialized).not.toContain(TOOL_INPUT_MARKER.note);
    expect(Object.keys(decision).sort()).toEqual(['kind', 'reason']);
  });
});

describe('classifyTranscript: input immutability', () => {
  it('does not mutate the prior or current comparison state it is given', () => {
    const priorMessages = deepFreeze([userText('turn 1'), assistantText('reply 1')]);
    const currentMessages = deepFreeze([userText('turn 1'), assistantText('reply 1'), userText('turn 2')]);
    const prior = deepFreeze(baseState(priorMessages));
    const current = deepFreeze(baseState(currentMessages));

    expect(() => classifyTranscript(prior, current)).not.toThrow();
    expect(classifyTranscript(prior, current)).toEqual({ kind: 'new-turn' });
  });
});
