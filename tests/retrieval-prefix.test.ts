import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { setPreserveCachePrefix } from '../src/config.js';
import type { ProviderModelSpec } from '../src/language-model-factory.js';
import { getConfigPath } from '../src/paths.js';
import { createModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';
import { upstreamResponsesStream } from './fixtures/chatgpt-plan-responses.js';

const upstream = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  compatibleBaseUrl: 'https://retrieval-fixture.invalid/v1',
}));

vi.mock('../src/registry/url-security.js', () => ({
  revalidateCustomEndpointUrl: (url: string) => Promise.resolve({ ok: url === upstream.compatibleBaseUrl }),
}));

vi.mock('../src/provider-factory.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/provider-factory.js')>();
  const { createLanguageModel } = await import('../src/language-model-factory.js');
  return { ...real, createLanguageModel: (spec: ProviderModelSpec) => createLanguageModel({ ...spec, fetch: upstream.fetch }) };
});

afterEach(() => {
  upstream.fetch.mockReset();
  vi.unstubAllEnvs();
});

const sessionId = '11111111-1111-4111-8111-111111111111';
const retrievalName = 'mcp__leverframe-retrieval__read_source_range';
const marker = 'retrieval_fixture_marker';
const search = { name: 'ToolSearch', description: 'Find a deferred tool', input_schema: {
  type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
} };
const routes = [
  {
    id: 'gpt-6.2-astra', providerId: 'openai-chatgpt-plan', authType: 'oauth', npm: '@ai-sdk/openai',
    url: 'https://api.openai.com/v1/responses', historyField: 'input', toolOutputSelector: { type: 'function_call_output', call_id: 'read-1' },
  },
  {
    id: 'fixture-chat-model', providerId: 'fixture-compatible', authType: 'api', npm: '@ai-sdk/openai-compatible',
    apiBaseUrl: upstream.compatibleBaseUrl, url: `${upstream.compatibleBaseUrl}/chat/completions`,
    historyField: 'messages', toolOutputSelector: { role: 'tool', tool_call_id: 'read-1' },
  },
] as const;

type Route = typeof routes[number];
type WireRequest = { tools?: unknown[]; input?: object[]; messages?: object[] };

function compatibleReply() {
  return Response.json({
    id: 'chatcmpl_fixture', object: 'chat.completion', created: 100, model: 'fixture-chat-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fixture response' } }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  });
}

async function readLocalEvidence() {
  const home = homedir();
  expect(home).toBe(process.env['HOME']);
  const workspace = mkdtempSync(join(home, 'retrieval-prefix-'));
  execFileSync('git', ['init', '--quiet', workspace]);
  writeFileSync(join(workspace, 'fixture.ts'), marker);
  execFileSync('git', ['-C', workspace, 'add', 'fixture.ts']);

  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const rejectFetch = 'globalThis.fetch=()=>Promise.reject(new Error("Fixture forbids network"))';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'retrieval', 'serve', '--workspace', workspace],
    env: {
      ...getDefaultEnvironment(), HOME: home, LEVERFRAME_HOME: join(home, 'leverframe'),
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(rejectFetch)}`,
    },
  });
  const client = new Client({ name: 'retrieval-prefix-fixture', version: '1.0.0' });
  onTestFinished(async () => {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const read = tools.find(tool => tool.name === 'read_source_range');
  if (!read) throw new Error('MCP did not advertise source reads');
  const searched = await client.callTool({ name: 'search_locations', arguments: { query: 'fixture.ts' } });
  const searchResult = (searched.content as { text: string }[])[0].text;
  const { locations: [location] } = JSON.parse(searchResult) as { locations: Record<string, unknown>[] };
  const result = await client.callTool({ name: read.name, arguments: location });
  return {
    tool: { name: retrievalName, description: read.description, defer_loading: true, input_schema: read.inputSchema },
    location,
    output: (result.content as { text: string }[])[0].text,
  };
}

async function startFixture(route: Route) {
  const home = homedir();
  expect(home).toBe(process.env['HOME']);
  expect(process.env['LEVERFRAME_HOME']).toBe(join(home, 'leverframe'));
  expect(getConfigPath()).toBe(join(home, 'leverframe', 'config.json'));
  vi.stubEnv('LEVERFRAME_OPENAI_APPEND_ONLY_TOOLS', '1');
  setPreserveCachePrefix(route.providerId, true);

  const model: ServerModelInfo = {
    ...route, name: 'Fixture', brand: 'fixture', isFree: false, sourceBackend: route.providerId,
    modelFormat: 'openai', apiKey: 'fixture-key', contextWindow: 128_000,
  };
  upstream.fetch.mockImplementation(async () => route.authType === 'oauth' ? upstreamResponsesStream() : compatibleReply());
  const server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway', serverPassword: null, catalog: createModelCatalog([model]),
  });
  onTestFinished(() => server.close());
  const send = async (messages: object[], tools: object[]) => {
    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': sessionId },
      body: JSON.stringify({ model: route.id, max_tokens: 256, system: 'Help inspect the workspace.', messages, tools }),
    });
    const body = await response.text();
    if (response.status !== 200) throw new Error(body);
  };
  return {
    send,
    requests: async () => Promise.all(upstream.fetch.mock.calls.map(async ([url, init]) => {
      const request = new Request(url, init);
      expect(request.url).toBe(route.url);
      expect(request.method).toBe('POST');
      return await request.json() as WireRequest;
    })),
  };
}

function toolTurn(name: string, id: string, input: object, content: string | object[]) {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', name, id, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ];
}

it.each(routes)('preserves the $providerId history prefix through discovery and a retrieval result', async route => {
  const gateway = await startFixture(route);
  const evidence = await readLocalEvidence();
  const initial = [{ role: 'user', content: 'Inspect the fixture.' }];
  const discovery = [...initial, ...toolTurn('ToolSearch', 'discover-1', { query: retrievalName }, [
    { type: 'tool_reference', tool_name: retrievalName },
  ])];
  const withSource = [...discovery, ...toolTurn(retrievalName, 'read-1', evidence.location, evidence.output)];

  await gateway.send(initial, [search, evidence.tool]);
  await gateway.send(discovery, [search, evidence.tool]);
  await gateway.send(withSource, [search, evidence.tool]);
  const [first, second, third] = await gateway.requests();

  const [initialHistory, discoveryHistory, finalHistory] = [first, second, third].map(request => request[route.historyField]!);
  expect(JSON.stringify(discoveryHistory.slice(0, initialHistory.length))).toBe(JSON.stringify(initialHistory));
  expect(JSON.stringify(finalHistory.slice(0, discoveryHistory.length))).toBe(JSON.stringify(discoveryHistory));
  expect(JSON.stringify(first)).not.toContain(retrievalName);
  expect(JSON.stringify(second)).not.toContain(marker);
  expect(JSON.stringify(finalHistory.find(item => expect.objectContaining(route.toolOutputSelector).asymmetricMatch(item)))).toContain(marker);
  const declaration = route.authType === 'oauth'
    ? discoveryHistory.at(-1)
    : second.tools?.at(-1);
  const { properties, required } = evidence.tool.input_schema;
  const declaredTool = { name: retrievalName, parameters: { type: 'object', properties, required } };
  const expected = route.authType === 'oauth'
    ? { type: 'additional_tools', role: 'developer', tools: [{ name: 'claude_code', tools: [{ ...declaredTool, strict: false }] }] }
    : { type: 'function', function: declaredTool };
  expect(declaration).toMatchObject(expected);
  expect(JSON.stringify(third.tools?.slice(0, first.tools?.length))).toBe(JSON.stringify(first.tools));
});

it.each(routes)('keeps retrieval out of tool definitions on a default $providerId session', async route => {
  const gateway = await startFixture(route);

  await gateway.send([{ role: 'user', content: 'Inspect the fixture.' }], [search]);

  const [request] = await gateway.requests();
  expect(JSON.stringify(request.tools)).toContain('ToolSearch');
  expect(JSON.stringify(request)).not.toMatch(/search_locations|read_source_range/);
});
