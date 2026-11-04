import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE } from '../src/constants.js';
import { executableRoutingHandoffSource, routingHandoffSchemaGlobals } from './fixtures/claude-agent-2.1.314-routing.js';

function buildRequest(agentContext: Record<string, unknown>, model: string, routingActive: boolean, tools: Array<Record<string, unknown>>,
  inheritedTools: Array<Record<string, unknown>>, inheritedShape?: { shapeInheritedFields: (inherited: { tools: Array<Record<string, unknown>> },
    shaped: { system: string; tools: Array<Record<string, unknown>> }) => { system: string; tools?: Array<Record<string, unknown>> } }) {
  const executable = executableRoutingHandoffSource();
  return runInNewContext(executable + ';buildRequest({model,system:"router-system",tools:[...tools,...inheritedTools],inherited:{tools:inheritedTools},agentContext},null)', {
    process: { env: routingActive ? { [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } : {} },
    agentContext,
    model,
    tools,
    inheritedTools,
    ...routingHandoffSchemaGlobals(),
    Fli: (value: unknown) => value,
    s8t: (value: unknown) => value,
    gt: {},
    jn: (model: string) => model,
    cG: () => undefined,
    D0: {},
    Ih: inheritedShape ?? { shapeInheritedFields: (_inherited: { tools: Array<Record<string, unknown>> }, shaped: { system: string; tools: Array<Record<string, unknown>> }) => shaped },
    Die: () => [],
    a6e: (metadata: unknown) => metadata,
  }) as { tools: Array<Record<string, unknown>> | undefined };
}

function cachedNativeShape() {
  let previousTools = '';
  return {
    shapeInheritedFields: (_inherited: { tools: Array<Record<string, unknown>> }, shaped: { system: string; tools: Array<Record<string, unknown>> }) => {
      const currentTools = JSON.stringify(shaped.tools);
      if (currentTools === previousTools) return { ...shaped, tools: undefined };
      previousTools = currentTools;
      return shaped;
    },
  };
}

function toolPool() {
  return [
    { name: 'Agent', description: 'Delegate a task.', input_schema: { type: 'object' } },
    { name: 'Read', description: 'Read a file.', input_schema: { type: 'object' } },
    { name: 'Edit', description: 'Edit a file.', input_schema: { type: 'object' } },
    { name: 'Bash', description: 'Run a command.', input_schema: { type: 'object' } },
  ];
}

function inheritedToolPool() {
  return [{ name: 'connected-tool', description: 'Use a connected service.', input_schema: { type: 'object' } }];
}

it('exposes delegation only to the active main request after inherited tools are shaped', () => {
  const tools = toolPool();
  const inheritedTools = inheritedToolPool();

  const request = buildRequest({ agentType: 'main' }, 'router-model', true, tools, inheritedTools);

  expect(request.tools).toEqual([tools[0]]);
});

it('keeps native tool-shape continuation stable across repeated active main turns', () => {
  const tools = toolPool();
  const inheritedTools = inheritedToolPool();
  const inheritedShape = cachedNativeShape();

  const first = buildRequest({ agentType: 'main' }, 'router-model', true, tools, inheritedTools, inheritedShape);
  const second = buildRequest({ agentType: 'main' }, 'router-model', true, tools, inheritedTools, inheritedShape);

  expect(first.tools).toEqual([tools[0]]);
  expect(second.tools).toBeUndefined();
  expect(tools).toEqual([...toolPool()]);
});

it.each([
  { label: 'bound specialist', agentContext: { agentType: 'subagent', leverframeRoutingBinding: 'fixture-binding',
    leverframeRoutingPolicyModel: 'specialist-model' }, model: 'specialist-model', routingActive: true },
  { label: 'main with routing off', agentContext: { agentType: 'main' }, model: 'router-model', routingActive: false },
])('keeps the complete inherited tool pool for a $label request', ({ agentContext, model, routingActive }) => {
  const tools = toolPool();
  const inheritedTools = inheritedToolPool();

  const request = buildRequest(agentContext, model, routingActive, tools, inheritedTools);

  expect(request.tools).toEqual([...tools, ...inheritedTools]);
});

it.each([
  { label: 'missing role', agentContext: {} },
  { label: 'unbound specialist', agentContext: { agentType: 'subagent' } },
])('restricts an active $label request to delegation', ({ agentContext }) => {
  const tools = toolPool();
  const inheritedTools = inheritedToolPool();

  const request = buildRequest(agentContext, 'router-model', true, tools, inheritedTools);

  expect(request.tools).toEqual([tools[0]]);
});

it.each([
  { label: 'partial specialist binding', agentContext: { agentType: 'subagent', leverframeRoutingBinding: 'fixture-binding' }, model: 'specialist-model' },
  { label: 'mismatched specialist model', agentContext: { agentType: 'subagent', leverframeRoutingBinding: 'fixture-binding',
    leverframeRoutingPolicyModel: 'selected-specialist-model' }, model: 'changed-specialist-model' },
])('fails before request creation for a $label', ({ agentContext, model }) => {
  const tools = toolPool();
  const inheritedTools = inheritedToolPool();

  expect(() => buildRequest(agentContext, model, true, tools, inheritedTools)).toThrow();
});
