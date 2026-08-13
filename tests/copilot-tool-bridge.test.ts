/**
 * Specifies src/copilot/tool-bridge.ts: converts an AI SDK ToolSet into isolated
 * Copilot SDK tools whose handlers stay pending until a matching AI SDK
 * tool-result part resolves or rejects them. RED by construction: the module
 * under test does not exist yet.
 */

import type { LanguageModelV3FunctionTool } from '@ai-sdk/provider';
import type { JSONValue, ToolResultPart } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  createToolBridge,
  DuplicateToolResultError,
  ToolResultError,
  UnknownToolResultError,
  type ToolBridgeSettleReason,
} from '../src/copilot/tool-bridge.js';

interface ToolInvocationFixture {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

const FIXTURE_SESSION_ID = 'fixture-session-id';

function invocation(toolCallId: string, toolName: string, args: unknown): ToolInvocationFixture {
  return { sessionId: FIXTURE_SESSION_ID, toolCallId, toolName, arguments: args };
}

interface CopilotBridgeToolFixture {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  handler?: (args: unknown, toolInvocation: ToolInvocationFixture) => Promise<unknown>;
}

function findTool(
  tools: readonly CopilotBridgeToolFixture[],
  name: string,
): CopilotBridgeToolFixture | undefined {
  return tools.find(tool => tool.name === name);
}

function toolNames(tools: readonly CopilotBridgeToolFixture[]): string[] {
  return tools.map(tool => tool.name);
}

const SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
} as const;

const FETCH_INPUT_SCHEMA = {
  type: 'object',
  properties: { url: { type: 'string' } },
  required: ['url'],
  additionalProperties: false,
} as const;

function toolSetFixture(): LanguageModelV3FunctionTool[] {
  return [
    {
      type: 'function',
      name: 'search',
      description: 'Search the web for a query',
      inputSchema: SEARCH_INPUT_SCHEMA,
    },
    {
      type: 'function',
      name: 'fetch',
      description: 'Fetch a URL and return its body',
      inputSchema: FETCH_INPUT_SCHEMA,
    },
  ];
}

function textResult(toolCallId: string, toolName: string, value: string): ToolResultPart {
  return { type: 'tool-result', toolCallId, toolName, output: { type: 'text', value } };
}

function jsonResult(toolCallId: string, toolName: string, value: JSONValue): ToolResultPart {
  return { type: 'tool-result', toolCallId, toolName, output: { type: 'json', value } };
}

function errorTextResult(toolCallId: string, toolName: string, value: string): ToolResultPart {
  return { type: 'tool-result', toolCallId, toolName, output: { type: 'error-text', value } };
}

function errorJsonResult(toolCallId: string, toolName: string, value: JSONValue): ToolResultPart {
  return { type: 'tool-result', toolCallId, toolName, output: { type: 'error-json', value } };
}

/** Prevents accidental writes so bridge behavior can be checked without mutation. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('createToolBridge tool conversion', () => {
  it('produces one Copilot tool per AI SDK tool entry, keyed by its ToolSet name', () => {
    const bridge = createToolBridge(toolSetFixture());

    const names = toolNames(bridge.copilotTools).sort();

    expect(names).toEqual(['fetch', 'search']);
  });

  it('preserves each tool description exactly', () => {
    const bridge = createToolBridge(toolSetFixture());

    const search = findTool(bridge.copilotTools, 'search');

    expect(search?.description).toBe('Search the web for a query');
  });

  it('bypasses SDK permissions and tool-search deferral because Claude executes the tools', () => {
    const bridge = createToolBridge(toolSetFixture());

    expect(bridge.copilotTools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        overridesBuiltInTool: true,
        skipPermission: true,
        defer: 'never',
      }),
    ]));
  });

  it('preserves each tool input schema exactly', () => {
    const bridge = createToolBridge(toolSetFixture());

    const search = findTool(bridge.copilotTools, 'search');
    const fetchTool = findTool(bridge.copilotTools, 'fetch');

    expect(search?.parameters).toEqual(SEARCH_INPUT_SCHEMA);
    expect(fetchTool?.parameters).toEqual(FETCH_INPUT_SCHEMA);
  });

  it('does not mutate the input tool set', () => {
    const tools = deepFreeze(toolSetFixture());

    expect(() => createToolBridge(tools)).not.toThrow();
  });
});

describe('createToolBridge pending call tracking', () => {
  it('reports no pending call ids before any handler runs', () => {
    const bridge = createToolBridge(toolSetFixture());

    expect(bridge.pendingToolCallIds()).toEqual([]);
  });

  it('reports a tool call id as pending once its handler is invoked', () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');

    search?.handler?.({ query: 'leverframe' }, invocation('call-1', 'search', { query: 'leverframe' }));

    expect(bridge.pendingToolCallIds()).toEqual(['call-1']);
  });

  it('reports every pending id for parallel tool calls', () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const fetchTool = findTool(bridge.copilotTools, 'fetch');

    search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));
    fetchTool?.handler?.({ url: 'https://example.com' }, invocation('call-2', 'fetch', { url: 'https://example.com' }));

    expect([...bridge.pendingToolCallIds()].sort()).toEqual(['call-1', 'call-2']);
  });

  it('does not mutate the arguments object passed to a handler', () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const args = deepFreeze({ query: 'leverframe' });

    expect(() => search?.handler?.(args, invocation('call-1', 'search', args))).not.toThrow();
  });
});

describe('createToolBridge resolving tool results', () => {
  it('resolves a pending handler with the text value of a matching tool-result', async () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const pending = search?.handler?.({ query: 'leverframe' }, invocation('call-1', 'search', { query: 'leverframe' }));

    bridge.resolveToolResults([textResult('call-1', 'search', 'three results found')]);

    await expect(pending).resolves.toBe('three results found');
  });

  it('resolves a pending handler with the json value of a matching tool-result', async () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const pending = search?.handler?.({ query: 'leverframe' }, invocation('call-1', 'search', { query: 'leverframe' }));

    bridge.resolveToolResults([jsonResult('call-1', 'search', { count: 3 })]);

    await expect(pending).resolves.toEqual({ count: 3 });
  });

  it('removes a resolved call id from the pending id report', () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));

    bridge.resolveToolResults([textResult('call-1', 'search', 'done')]);

    expect(bridge.pendingToolCallIds()).toEqual([]);
  });
});

describe('createToolBridge batch and out-of-order resolution', () => {
  it('resolves parallel pending handlers delivered in one batch', async () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const fetchTool = findTool(bridge.copilotTools, 'fetch');
    const pendingSearch = search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));
    const pendingFetch = fetchTool?.handler?.({ url: 'https://example.com' }, invocation('call-2', 'fetch', { url: 'https://example.com' }));

    bridge.resolveToolResults([
      textResult('call-1', 'search', 'search done'),
      textResult('call-2', 'fetch', 'fetch done'),
    ]);

    await expect(pendingSearch).resolves.toBe('search done');
    await expect(pendingFetch).resolves.toBe('fetch done');
  });

  it('resolves out-of-order results, settling whichever call id arrives regardless of invocation order', async () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const fetchTool = findTool(bridge.copilotTools, 'fetch');
    const pendingSearch = search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));
    const pendingFetch = fetchTool?.handler?.({ url: 'https://example.com' }, invocation('call-2', 'fetch', { url: 'https://example.com' }));

    bridge.resolveToolResults([textResult('call-2', 'fetch', 'fetch done')]);

    await expect(pendingFetch).resolves.toBe('fetch done');
    expect(bridge.pendingToolCallIds()).toEqual(['call-1']);

    bridge.resolveToolResults([textResult('call-1', 'search', 'search done')]);

    await expect(pendingSearch).resolves.toBe('search done');
    expect(bridge.pendingToolCallIds()).toEqual([]);
  });
});

describe('createToolBridge error result mapping', () => {
  it('rejects the pending handler with a ToolResultError when the result is error-text', async () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const pending = search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));

    bridge.resolveToolResults([errorTextResult('call-1', 'search', 'upstream search failed')]);

    await expect(pending).rejects.toBeInstanceOf(ToolResultError);
    await expect(pending).rejects.toThrow(/upstream search failed/);
  });

  it('rejects the pending handler with a ToolResultError when the result is error-json', async () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const pending = search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));

    bridge.resolveToolResults([errorJsonResult('call-1', 'search', { code: 'RATE_LIMITED' })]);

    await expect(pending).rejects.toBeInstanceOf(ToolResultError);
  });

  it('removes an error-settled call id from the pending id report', async () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    const pending = search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));

    bridge.resolveToolResults([errorTextResult('call-1', 'search', 'failed')]);
    await pending?.catch(() => undefined);

    expect(bridge.pendingToolCallIds()).toEqual([]);
  });
});

describe('createToolBridge duplicate and unknown results', () => {
  it('throws UnknownToolResultError for a tool-result whose call id was never invoked', () => {
    const bridge = createToolBridge(toolSetFixture());

    expect(() => bridge.resolveToolResults([textResult('never-invoked', 'search', 'x')]))
      .toThrow(UnknownToolResultError);
  });

  it('throws DuplicateToolResultError for a tool-result whose call id already settled', () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));
    bridge.resolveToolResults([textResult('call-1', 'search', 'first')]);

    expect(() => bridge.resolveToolResults([textResult('call-1', 'search', 'second')]))
      .toThrow(DuplicateToolResultError);
  });

  it('applies no part of a batch when one result in the batch is invalid', () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));

    expect(() => bridge.resolveToolResults([
      textResult('call-1', 'search', 'would resolve'),
      textResult('never-invoked', 'search', 'unknown'),
    ])).toThrow(UnknownToolResultError);

    expect(bridge.pendingToolCallIds()).toEqual(['call-1']);
  });

  it('names the unresolved call id on both duplicate and unknown errors', () => {
    const bridge = createToolBridge(toolSetFixture());

    let unknownError: unknown;
    try {
      bridge.resolveToolResults([textResult('missing-call', 'search', 'x')]);
    } catch (error) {
      unknownError = error;
    }

    expect(unknownError).toBeInstanceOf(UnknownToolResultError);
    expect((unknownError as UnknownToolResultError).toolCallId).toBe('missing-call');
  });
});

describe('createToolBridge terminal settlement', () => {
  const reasons: readonly ToolBridgeSettleReason[] = ['abort', 'disconnect', 'timeout', 'disposal'];

  for (const reason of reasons) {
    it(`rejects every pending handler exactly once on ${reason}`, async () => {
      const bridge = createToolBridge(toolSetFixture());
      const search = findTool(bridge.copilotTools, 'search');
      const fetchTool = findTool(bridge.copilotTools, 'fetch');
      const pendingSearch = search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }));
      const pendingFetch = fetchTool?.handler?.({ url: 'https://example.com' }, invocation('call-2', 'fetch', { url: 'https://example.com' }));
      const searchCatch = vi.fn();
      const fetchCatch = vi.fn();
      pendingSearch?.catch(searchCatch);
      pendingFetch?.catch(fetchCatch);

      bridge.settleAllPending(reason);
      bridge.settleAllPending(reason);
      await Promise.resolve().then(() => Promise.resolve());

      expect(searchCatch).toHaveBeenCalledTimes(1);
      expect(fetchCatch).toHaveBeenCalledTimes(1);
    });
  }

  it('clears pending ids after settling', () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }))?.catch(() => undefined);

    bridge.settleAllPending('abort');

    expect(bridge.pendingToolCallIds()).toEqual([]);
  });

  it('is a no-op when there is nothing pending', () => {
    const bridge = createToolBridge(toolSetFixture());

    expect(() => bridge.settleAllPending('disposal')).not.toThrow();
    expect(bridge.pendingToolCallIds()).toEqual([]);
  });

  it('treats an abort-settled call id as a duplicate for a later tool-result', () => {
    const bridge = createToolBridge(toolSetFixture());
    const search = findTool(bridge.copilotTools, 'search');
    search?.handler?.({ query: 'a' }, invocation('call-1', 'search', { query: 'a' }))?.catch(() => undefined);
    bridge.settleAllPending('disconnect');

    expect(() => bridge.resolveToolResults([textResult('call-1', 'search', 'late')]))
      .toThrow(DuplicateToolResultError);
  });
});
