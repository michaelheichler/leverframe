import { describe, expect, it } from 'vitest';
import { decideHttpProxyRoute } from '../src/http-proxy/routing-decision.js';
import { translateRequest, type AnthropicRequest } from '../src/sdk-request-translation.js';

const serverSearch = {
  type: 'tool_search_tool_regex_20251119',
  name: 'tool_search_tool_regex',
};
const clientSearch = {
  name: 'ToolSearch',
  description: 'Find tools in the client registry.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};
const bash = { name: 'Bash', input_schema: { type: 'object', properties: {} } };
const deferredTools = Array.from({ length: 12 }, (_, index) => ({
  name: `mcp__fixture__action_${index}`,
  description: 'Perform a fixture action.',
  input_schema: { type: 'object', properties: {} },
  defer_loading: true,
}));

describe('Headroom tool search through the HTTP proxy', () => {
  it.each(['@ai-sdk/openai', '@ai-sdk/openai-compatible'])(
    'keeps tools callable when %s cannot execute Anthropic server search',
    npm => {
      const params = translateRequest({
        model: 'leverframe:fixture:large-context-test',
        messages: [{ role: 'user', content: 'Use the MCP tools.' }],
        tools: [serverSearch, bash, ...deferredTools] as AnthropicRequest['tools'],
      }, npm);

      expect(Object.keys(params.tools ?? {}))
        .toEqual(['Bash', ...deferredTools.map(tool => tool.name)]);
    },
  );

  it.each([false, true])(
    'keeps client ToolSearch deferral when server search is present: %s',
    withServerSearch => {
      const tools = [
        ...(withServerSearch ? [serverSearch] : []),
        clientSearch,
        bash,
        ...deferredTools,
      ] as AnthropicRequest['tools'];
      const request: AnthropicRequest = {
        model: 'leverframe:fixture:large-context-test',
        messages: [{ role: 'user', content: 'Find a tool.' }],
        tools,
      };

      expect(Object.keys(translateRequest(request, '@ai-sdk/openai').tools ?? {}))
        .toEqual(['ToolSearch', 'Bash']);

      const referenced = translateRequest({
        ...request,
        messages: [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'search_call',
            content: [{ type: 'tool_reference', tool_name: 'mcp__fixture__action_0' }],
          }],
        }],
      }, '@ai-sdk/openai');

      expect(Object.keys(referenced.tools ?? {}))
        .toEqual(['ToolSearch', 'Bash', 'mcp__fixture__action_0']);
    },
  );

  it('keeps native Anthropic server search on the subscription passthrough route', () => {
    const rawBody = Buffer.from(JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Use the MCP tools.' }],
      tools: [serverSearch, bash, ...deferredTools],
    }));
    const decision = decideHttpProxyRoute({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: 'Bearer subscription-fixture' },
      rawBody,
      routesById: new Map(),
      hasAdapter: true,
    });

    expect(decision).toMatchObject({
      action: 'passthrough-messages',
      modelId: 'claude-sonnet-4-6',
    });
  });
});
