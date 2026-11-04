import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE } from '../src/constants.js';
import { applyModelRoutingTransform } from '../src/patch-transforms-model-routing.js';
import {
  claudeAgentRoutingHandoffSource,
  executableRoutingHandoffSource,
  ROUTING_TEST_PROMPT_POLICY,
  routingHandoffSchemaGlobals,
} from './fixtures/claude-agent-2.1.314-routing.js';

const moduleBoundary = '\n//#__leverframe_claude_module__:';
const streamModuleName = '/$bunfs/root/chunk-m76gkyft.js';
const nativeSend = 'async function runAndSend(input){let resolved;for await(const result of tP(input))resolved=result;return send(buildRequest({model:resolved.model,effort:resolved.effort,contextWindow:resolved.contextWindow,agentContext:resolved.agentContext,max_tokens:input.max_tokens??100},null))}';
const shapedSend = 'async function runAndSend(input){let resolved;for await(const result of tP(input))resolved=result;return send(buildRequest({...resolved,tools:input.tools,inherited:input.inherited,system:input.system,max_tokens:input.max_tokens??100},null))}';
const nativeC1 = 'async function* C1(e,s,n,h){let w=e.name,L=Ub(s.options.tools,w,s.options.toolAliases);return}';
const c1Fixture = 'async function* C1(e,s,n,h){let w=e.name,L=Ub(s.options.tools,w,s.options.toolAliases);if(!L&&e.name.startsWith("mcp__")){let d=await refreshDynamic(e.name,s);if(d){yield* C1(e,{...s,options:{...s.options,tools:[...s.options.tools,d]}},n,h);return}}if(s.options.remote){let result=await remoteDispatch(L,e);yield{message:result};return}L7s(w,L.name);let{connection:Z,ambiguous:ke}=SH(w,s.options.mcpClients);let result=await callTool(L,e.input);yield{message:result}}async function executeTool(e,s,n){let results=[];for await(const item of C1(e,s,n,Date.now))results.push(item);return results}';
const nativeStreamFixture = 'class Js{addTool(e,n){let r=Ub(this.toolDefinitions,e.name,this.toolUseContext.options.toolAliases);return r}}';
const streamFixture = `class Js{constructor(toolDefinitions,toolUseContext){this.toolDefinitions=toolDefinitions;this.toolUseContext=toolUseContext;this.tools=[];this.events=toolUseContext.events;this.now=()=>1}addTool(e,n){let r=Ub(this.toolDefinitions,e.name,this.toolUseContext.options.toolAliases);if(r!==void 0){let parsed=r.inputSchema.safeParse(e.input);if(!parsed.success)return;let safe=isConcurrencySafe(r,e.input);let result=callTool(r,e.input);this.tools.push({id:e.id,block:e,assistantMessage:n,status:"completed",isConcurrencySafe:safe,pendingProgress:[],pendingBridgeEvents:[],results:[result]});this.wakeWaiters();return}if(e.name.startsWith("mcp__")){AWt(e.name);return}}wakeWaiters(){this.events.push("wake")}finishedResults(){return this.tools.flatMap(item=>item.results)}}`;

function sourceWithExecutionFixture(): string {
  const source = claudeAgentRoutingHandoffSource();
  return source.replace(nativeC1, c1Fixture).replace(nativeSend, shapedSend).replace(nativeStreamFixture, streamFixture);
}

function createHarness(routingActive: boolean, events: string[], sent: Array<Record<string, unknown>> = []) {
  const executable = executableRoutingHandoffSource(sourceWithExecutionFixture());
  const runtime = runInNewContext(executable + ';({buildRequest,runAndSend,executeTool,Js})', {
    process: { env: routingActive ? { [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } : {} },
    ...routingHandoffSchemaGlobals(),
    s8t: (value: unknown) => value,
    gt: {},
    Fli: (value: unknown) => value,
    jn: (model: string) => model,
    cG: () => undefined,
    D0: {},
    a6e: (metadata: unknown) => metadata,
    Ih: { shapeInheritedFields: (inherited: { tools: Array<Record<string, unknown>> }, shaped: { system: string; tools: Array<Record<string, unknown>> }) => ({
      ...shaped, tools: [...shaped.tools, ...inherited.tools],
    }) },
    Die: () => [],
    EKs: (_definition: unknown, _parent: string, model: string) => model,
    iAe: (_definition: unknown, parent: string) => parent,
    FWr: (context: { agentContext: Record<string, unknown> }) => ({ agentContext: context.agentContext }),
    send: (request: Record<string, unknown>) => { sent.push(request); events.push('provider'); return request; },
    Ub: (tools: Array<Record<string, unknown>>, name: string, aliases: Record<string, string>) => {
      const canonical = aliases[name] ?? name;
      return tools.find(tool => tool.name === canonical);
    },
    Oe: (result: unknown) => result,
    remoteDispatch: (tool: { name: string }) => { events.push('remote'); return { dispatched: tool.name }; },
    callTool: (tool: { name: string }) => { events.push('tool-call'); return { called: tool.name }; },
    L7s: () => { events.push('tool-log'); },
    SH: () => { events.push('connection'); return { connection: undefined, ambiguous: false }; },
    refreshDynamic: (name: string) => {
      events.push('refresh');
      return { name, inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) } };
    },
    AWt: () => { events.push('refresh'); },
    isConcurrencySafe: () => { events.push('concurrency'); return true; },
  }) as {
    buildRequest: (input: Record<string, unknown>, messages: unknown) => { tools: Array<Record<string, unknown>> };
    runAndSend: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    executeTool: (block: Record<string, unknown>, context: Record<string, unknown>, assistant: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    Js: new (tools: Array<Record<string, unknown>>, context: Record<string, unknown>) => {
      addTool(block: Record<string, unknown>, assistant: Record<string, unknown>): void;
      finishedResults(): Array<Record<string, unknown>>;
    };
  };
  return { runtime, events, sent };
}

function routedToolContext(agentContext: Record<string, unknown>, model: string, tools: Array<Record<string, unknown>>,
  aliases: Record<string, string>, events: string[]) {
  return { agentContext, events, options: { mainLoopModel: model, tools, toolAliases: aliases, remote: true, mcpClients: [] } };
}

function tool(name: string) {
  return { name, inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) } };
}

it('denies an active router alias before remote or local tool dispatch', async () => {
  const events: string[] = [];
  const harness = createHarness(true, events);
  const result = await harness.runtime.executeTool({ id: 'tool-use', name: 'shell', input: {} },
    routedToolContext({ agentType: 'main' }, 'router-model', [tool('Bash')], { shell: 'Bash' }, events), { uuid: 'assistant-message' });

  expect(result).toMatchObject([{ message: { content: [{ type: 'tool_result', is_error: true, tool_use_id: 'tool-use' }] } }]);
  expect(events).toEqual([]);
});

it('allows the delegation alias after it resolves to the canonical Agent tool', async () => {
  const events: string[] = [];
  const harness = createHarness(true, events);
  const result = await harness.runtime.executeTool({ id: 'delegate-use', name: 'task', input: {} },
    routedToolContext({ agentType: 'main' }, 'router-model', [tool('Agent')], { task: 'Agent' }, events), { uuid: 'assistant-message' });

  expect(result).toEqual([{ message: { dispatched: 'Agent' } }]);
  expect(events).toEqual(['remote']);
});

it('denies unresolved dynamic tools before refresh for an active router', async () => {
  const events: string[] = [];
  const harness = createHarness(true, events);
  const result = await harness.runtime.executeTool({ id: 'dynamic-use', name: 'mcp__new_service', input: {} },
    routedToolContext({ agentType: 'main' }, 'router-model', [], {}, events), { uuid: 'assistant-message' });

  expect(result).toMatchObject([{ message: { content: [{ type: 'tool_result', is_error: true, tool_use_id: 'dynamic-use' }] } }]);
  expect(events).toEqual([]);
});

it.each([
  { label: 'bound specialist', agentContext: { agentType: 'subagent', leverframeRoutingBinding: 'fixture-binding',
    leverframeRoutingPolicyModel: 'specialist-model' }, model: 'specialist-model', active: true },
  { label: 'routing off', agentContext: { agentType: 'main' }, model: 'router-model', active: false },
])('preserves native tool dispatch for a $label', async ({ agentContext, model, active }) => {
  const events: string[] = [];
  const harness = createHarness(active, events);
  const result = await harness.runtime.executeTool({ id: 'tool-use', name: 'shell', input: {} },
    routedToolContext(agentContext, model, [tool('Bash')], { shell: 'Bash' }, events), { uuid: 'assistant-message' });

  expect(result).toEqual([{ message: { dispatched: 'Bash' } }]);
  expect(events).toEqual(['remote']);
});

it('stops tool preparation before parse, concurrency, refresh, or call for an active router', () => {
  const events: string[] = [];
  const harness = createHarness(true, events);
  const manager = new harness.runtime.Js([tool('Bash')], routedToolContext({ agentType: 'main' }, 'router-model',
    [tool('Bash')], { shell: 'Bash' }, events));

  manager.addTool({ id: 'tool-use', name: 'shell', input: {} }, { uuid: 'assistant-message' });

  expect(manager.finishedResults()).toMatchObject([{ content: [{ type: 'tool_result', is_error: true, tool_use_id: 'tool-use' }] }]);
  expect(events).toEqual(['wake']);
});

it('stops dynamic tool refresh before it runs for an active router', () => {
  const events: string[] = [];
  const harness = createHarness(true, events);
  const manager = new harness.runtime.Js([], routedToolContext({ agentType: 'main' }, 'router-model', [], {}, events));

  manager.addTool({ id: 'dynamic-use', name: 'mcp__new_service', input: {} }, { uuid: 'assistant-message' });

  expect(manager.finishedResults()).toMatchObject([{ content: [{ type: 'tool_result', is_error: true, tool_use_id: 'dynamic-use' }] }]);
  expect(events).toEqual(['wake']);
});

it('fails before provider dispatch when the active router has no delegation schema', async () => {
  const events: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const harness = createHarness(true, events, sent);
  const context = { agentType: 'main' };

  await expect(harness.runtime.runAndSend({ model: 'router-model', tools: [], inherited: { tools: [] }, system: 'router-system',
    toolUseContext: { agentContext: context, contextWindow: 70_000, options: { mainLoopModel: 'router-model' } } })).rejects.toThrow();

  expect(sent).toEqual([]);
});

function moduleSection(source: string, name: string): string {
  const start = source.indexOf(`${moduleBoundary}${name}`);
  const end = source.indexOf(moduleBoundary, start + moduleBoundary.length);
  if (start < 0) throw new Error('Expected fixture module is unavailable.');
  return source.slice(start, end < 0 ? undefined : end);
}

it('fails closed when only the stream module carries a routing patch', () => {
  const source = sourceWithExecutionFixture();
  const fullyPatched = applyModelRoutingTransform(source, { enabled: true, promptPolicy: ROUTING_TEST_PROMPT_POLICY }).content;
  const streamSection = moduleSection(source, streamModuleName);
  const patchedStreamSection = moduleSection(fullyPatched, streamModuleName);
  const partial = source.replace(streamSection, patchedStreamSection);

  const result = applyModelRoutingTransform(partial, { enabled: true, promptPolicy: ROUTING_TEST_PROMPT_POLICY });

  expect(result.content).toBe(partial);
  expect(result.results.some(site => site.status === 'FAIL')).toBe(true);
});
