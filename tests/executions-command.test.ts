import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runExecutionsCommand } from '../src/executions-command.js';
import { beginExecutionTracking } from '../src/execution-tracking.js';
import { getExecutionDetail } from '../src/execution-query.js';

const originalHome = process.env.LEVERFRAME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
  vi.restoreAllMocks();
});

function home(): void {
  process.env.LEVERFRAME_HOME = join(mkdtempSync(join(tmpdir(), 'leverframe-executions-cli-')), 'home');
}

function captureLogs(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
  return { logs, errors };
}

describe('runExecutionsCommand', () => {
  it('prints usage and exits 0 for --help and no args', async () => {
    const { logs } = captureLogs();
    expect(await runExecutionsCommand([])).toBe(0);
    expect(await runExecutionsCommand(['--help'])).toBe(0);
    expect(logs.some(line => line.includes('Usage: leverframe executions'))).toBe(true);
  });

  it('list reports no executions on an empty store', async () => {
    home();
    const { logs } = captureLogs();
    expect(await runExecutionsCommand(['list'])).toBe(0);
    expect(logs).toContain('No executions found.');
  });

  it('list prints a summary line per execution', async () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'cli-session-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { logs } = captureLogs();
    expect(await runExecutionsCommand(['list'])).toBe(0);
    expect(logs.some(line => line.includes(handle.executionId) && line.includes('status=pending'))).toBe(true);
  });

  it('show prints checkpoint/ledger JSON and exits 1 for an unknown execution', async () => {
    home();
    const { logs, errors } = captureLogs();
    expect(await runExecutionsCommand(['show', 'deadbeef'.repeat(4), 'missing-id'])).toBe(1);
    expect(errors).toEqual([]);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.found).toBe(false);
  });

  it('show exits 0 and includes the checkpoint for a real execution', async () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'cli-session-2',
      requestId: 'req-2',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { logs } = captureLogs();
    expect(await runExecutionsCommand(['show', handle.scopeHash, handle.executionId])).toBe(0);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.checkpoint.executionId).toBe(handle.executionId);
  });

  it('reconcile requires --executed/--not-executed and either --tool-call or --all', async () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'cli-session-3',
      requestId: 'req-3',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { errors } = captureLogs();
    expect(await runExecutionsCommand(['reconcile', handle.scopeHash, handle.executionId])).toBe(1);
    expect(errors.some(line => line.includes('Specify --executed or --not-executed'))).toBe(true);
  });

  it('reconcile --tool-call resolves an ambiguous emitted call without blind replay', async () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'cli-session-4',
      requestId: 'req-4',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: {} }] });

    const { logs } = captureLogs();
    const code = await runExecutionsCommand(['reconcile', handle.scopeHash, handle.executionId, '--tool-call', 'call_1', '--not-executed']);
    expect(code).toBe(0);
    expect(logs.some(line => line.includes('confirmed_not_executed'))).toBe(true);

    const detail = getExecutionDetail(handle.scopeHash, handle.executionId);
    expect(detail.ledger?.entries[0]?.status).toBe('confirmed_not_executed');
  });

  it('reconcile --all resolves every ambiguous entry', async () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'cli-session-5',
      requestId: 'req-5',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    handle.observeNonStreamAnthropic({
      content: [
        { type: 'tool_use', id: 'call_a', name: 'bash', input: {} },
        { type: 'tool_use', id: 'call_b', name: 'edit', input: {} },
      ],
    });

    const { logs } = captureLogs();
    const code = await runExecutionsCommand(['reconcile', handle.scopeHash, handle.executionId, '--all', '--executed']);
    expect(code).toBe(0);
    expect(logs.filter(line => line.includes('confirmed_executed'))).toHaveLength(2);
  });

  it('an unknown subcommand prints usage and exits 1', async () => {
    const { logs } = captureLogs();
    expect(await runExecutionsCommand(['bogus'])).toBe(1);
    expect(logs.some(line => line.includes('Usage: leverframe executions'))).toBe(true);
  });
});
