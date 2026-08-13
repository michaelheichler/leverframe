import type { LanguageModelV3FunctionTool } from '@ai-sdk/provider';
import type { ToolResultPart } from 'ai';
import { describe, expect, it } from 'vitest';
import { createToolBridge } from '../src/copilot/tool-bridge.js';

const TOOL: LanguageModelV3FunctionTool = {
  type: 'function',
  name: 'search',
  description: 'Search',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
  },
};

function invocation(toolCallId: string): {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
} {
  return {
    sessionId: 'fixture-session',
    toolCallId,
    toolName: 'search',
    arguments: { query: 'x' },
  };
}

describe('Copilot tool-result output validation', () => {
  it('rejects an unknown output type instead of resolving undefined', async () => {
    const bridge = createToolBridge([TOOL]);
    const tool = bridge.copilotTools[0];
    const pending = tool.handler({ query: 'x' }, invocation('call-1'));
    const invalid = {
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'search',
      output: { type: 'future-output', value: 'x' },
    } as unknown as ToolResultPart;

    expect(() => bridge.resolveToolResults([invalid])).toThrow(/output type/i);
    expect(bridge.pendingToolCallIds()).toEqual(['call-1']);
    bridge.settleAllPending('disposal');
    await expect(pending).rejects.toThrow(/disposal/);
  });
});
