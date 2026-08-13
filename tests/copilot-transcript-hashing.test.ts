// Deterministic Copilot prompt and session-key hash tests.

import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { serializeHistory } from '../src/copilot/serialized-history.js';
import {
  type CopilotSessionKeyInput,
  type CopilotToolSchema,
  deriveCopilotSessionKey,
  hashSystemPrompt,
  hashToolSchema,
  normalizePrompt,
} from '../src/copilot/transcript.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

function systemMessage(text: string): ModelMessage {
  return { role: 'system', content: text };
}

function userText(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function assistantText(text: string): ModelMessage {
  return { role: 'assistant', content: text };
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

describe('hashSystemPrompt', () => {
  it('is deterministic and hex-encoded sha256', () => {
    const hash = hashSystemPrompt('you are a coding assistant');
    expect(hash).toMatch(SHA256_HEX);
    expect(hashSystemPrompt('you are a coding assistant')).toBe(hash);
  });

  it('distinguishes different system prompt text', () => {
    expect(hashSystemPrompt('prompt A')).not.toBe(hashSystemPrompt('prompt B'));
  });

  it('distinguishes an empty system prompt from a non-empty one', () => {
    expect(hashSystemPrompt('')).not.toBe(hashSystemPrompt('x'));
  });
});

describe('hashToolSchema', () => {
  it('is order-independent across both tool array order and schema key order', () => {
    const reordered: readonly CopilotToolSchema[] = [
      {
        name: 'fetch',
        description: 'Fetch a URL',
        inputSchemaJson: { required: ['url'], properties: { url: { type: 'string' } }, type: 'object' },
      },
      {
        name: 'search',
        description: 'Search the web',
        inputSchemaJson: { required: ['q'], properties: { q: { type: 'string' } }, type: 'object' },
      },
    ];
    expect(hashToolSchema(reordered)).toBe(hashToolSchema(BASE_TOOLS));
  });

  it('changes when a tool schema field changes', () => {
    const changed: readonly CopilotToolSchema[] = [
      BASE_TOOLS[0],
      { ...BASE_TOOLS[1], inputSchemaJson: { type: 'object', properties: { url: { type: 'string' } }, required: [] } },
    ];
    expect(hashToolSchema(changed)).not.toBe(hashToolSchema(BASE_TOOLS));
  });

  it('changes when a tool is added or removed', () => {
    expect(hashToolSchema([BASE_TOOLS[0]])).not.toBe(hashToolSchema(BASE_TOOLS));
  });


  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    () => undefined,
    Symbol('invalid'),
  ])('rejects non-JSON schema values %#', value => {
    const tools: readonly CopilotToolSchema[] = [{
      name: 'invalid',
      description: null,
      inputSchemaJson: { value },
    }];
    expect(() => hashToolSchema(tools)).toThrow(TypeError);
  });
});


describe('deriveCopilotSessionKey', () => {
  const base: CopilotSessionKeyInput = {
    claudeSessionId: 'claude-session-alpha',
    upstreamModel: 'gpt-5-copilot',
    reasoningEffort: null,
    systemPromptHash: hashSystemPrompt('base system prompt'),
    toolSchemaHash: hashToolSchema(BASE_TOOLS),
  };

  it('is deterministic and hex-encoded sha256', () => {
    const key = deriveCopilotSessionKey(base);
    expect(key).toMatch(SHA256_HEX);
    expect(deriveCopilotSessionKey(base)).toBe(key);
  });

  it.each([
    ['claude session id', { ...base, claudeSessionId: 'claude-session-beta' }],
    ['upstream model', { ...base, upstreamModel: 'gpt-5-copilot-mini' }],
    ['reasoning effort', { ...base, reasoningEffort: 'high' }],
    ['system prompt hash', { ...base, systemPromptHash: hashSystemPrompt('a different system prompt') }],
    ['tool schema hash', { ...base, toolSchemaHash: hashToolSchema([BASE_TOOLS[0]]) }],
  ] as const)('changes when %s changes', (_label, changed) => {
    expect(deriveCopilotSessionKey(changed)).not.toBe(deriveCopilotSessionKey(base));
  });

  it('distinguishes null reasoning effort from an explicit string value', () => {
    const withNull: CopilotSessionKeyInput = { ...base, reasoningEffort: null };
    const withValue: CopilotSessionKeyInput = { ...base, reasoningEffort: 'null' };
    expect(deriveCopilotSessionKey(withNull)).not.toBe(deriveCopilotSessionKey(withValue));
  });
});


describe('normalizePrompt', () => {
  it('joins multiple system messages into one canonical system prompt', () => {
    const result = normalizePrompt([systemMessage('Part A'), systemMessage('Part B'), userText('hi')]);
    expect(result.systemPrompt).toBe('Part A\n\nPart B');
    expect(result.systemPromptHash).toBe(hashSystemPrompt('Part A\n\nPart B'));
  });

  it('yields an empty system prompt when no system message is present', () => {
    const result = normalizePrompt([userText('hi')]);
    expect(result.systemPrompt).toBe('');
  });

  it('excludes system messages from the serialized conversation history', () => {
    const result = normalizePrompt([systemMessage('be helpful'), userText('hi'), assistantText('hello')]);
    expect(result.history).toEqual(serializeHistory([userText('hi'), assistantText('hello')]));
  });

  it('does not mutate its input prompt', () => {
    const messages = deepFreeze([systemMessage('be helpful'), userText('hi')]);
    const before = JSON.stringify(messages);
    expect(() => normalizePrompt(messages)).not.toThrow();
    expect(JSON.stringify(messages)).toBe(before);
  });
});


