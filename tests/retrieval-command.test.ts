import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function fixture() {
  const home = homedir();
  expect(home).toBe(process.env['HOME']);
  expect(process.env['LEVERFRAME_HOME']).toBe(join(home, 'leverframe'));
  const workspace = mkdtempSync(join(home, 'retrieval-command-'));
  onTestFinished(() => rmSync(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', workspace]);
  writeFileSync(join(workspace, ' marker.ts'), 'export const marker = 1\n');
  execFileSync('git', ['-C', workspace, 'add', ' marker.ts']);
  return workspace;
}

function cliEnvironment() {
  const rejectFetch = 'globalThis.fetch=()=>Promise.reject(new Error("Fixture forbids network"))';
  return { ...process.env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(rejectFetch)}` };
}

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { env: cliEnvironment(), encoding: 'utf8', timeout: 5_000 });
}

interface Receipt {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: unknown;
}

interface ToolContent {
  type: 'text';
  text: string;
}

function connectStdio(workspace: string) {
  const child = spawn(process.execPath, [cli, 'retrieval', 'serve', '--workspace', workspace], { env: cliEnvironment() });
  const close = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
  const output = createInterface({ input: child.stdout });
  const lines = output[Symbol.asyncIterator]();
  onTestFinished(() => {
    output.close();
    child.kill();
  });

  let id = 0;
  const send = (method: string, params?: unknown, requestId?: number) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  };
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    const requestId = ++id;
    send(method, params, requestId);
    const reply = await lines.next();
    if (reply.done) throw new Error(`No JSON-RPC response to ${method}\n${stderr}`);
    const receipt = JSON.parse(reply.value) as Receipt;
    expect(receipt).toMatchObject({ jsonrpc: '2.0', id: requestId });
    expect(receipt.error).toBeUndefined();
    return receipt.result as T;
  };
  return {
    request,
    ready: () => send('notifications/initialized'),
    async stop() {
      child.stdin.end();
      const [exitCode, signal] = await close;
      return { exitCode, signal, trailingOutput: (await lines.next()).value, stderr };
    },
  };
}

it('negotiates MCP, lists stable read-only tools, and resolves a location over protocol-only stdout', async () => {
  const workspace = fixture();
  const connection = connectStdio(workspace);
  const initialize = await connection.request<{ protocolVersion: string }>('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'retrieval-fixture', version: '1' },
  });
  connection.ready();
  type ToolList = { tools: Array<{ name: string; annotations?: { readOnlyHint: boolean } }> };
  const first = await connection.request<ToolList>('tools/list');
  const second = await connection.request<ToolList>('tools/list');
  const search = await connection.request<{ content: ToolContent[] }>('tools/call', {
    name: 'search_locations',
    arguments: { query: ' marker.ts' },
  });
  const locations = JSON.parse(search.content[0].text) as { locations: object[] };
  expect(locations.locations).toMatchObject([{ path: ' marker.ts' }]);
  const read = await connection.request<{ content: ToolContent[] }>('tools/call', {
    name: 'read_source_range',
    arguments: locations.locations[0],
  });

  const stopped = await connection.stop();

  expect(initialize.protocolVersion).toBe('2025-11-25');
  expect(first.tools.map(tool => tool.name)).toEqual(['search_locations', 'read_source_range']);
  expect(first.tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
  expect(second).toEqual(first);
  expect(search.content).toHaveLength(1);
  expect(search.content[0].text).not.toContain('export const marker');
  expect(read.content).toHaveLength(1);
  expect(JSON.parse(read.content[0].text)).toMatchObject({ status: 'ok', text: 'export const marker = 1' });
  expect(stopped).toEqual({ exitCode: 0, signal: null, trailingOutput: undefined, stderr: '' });
});

it('rejects an invalid workspace without outputting protocol data or the path', () => {
  const invalid = join(fixture(), 'missing-fixture-workspace');

  const result = runCli('retrieval', 'serve', '--workspace', invalid);

  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).not.toBe('');
  expect(result.stderr).not.toContain(invalid);
});

it('advertises retrieval in the root command help', () => {
  const result = runCli('--help');

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('leverframe retrieval');
});
