import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  beginExecutionTracking,
  reconcileExecutionsAtStartup,
  reconcileIncomingToolResults,
  EXECUTION_GENERATION_HEADER,
  EXECUTION_ID_HEADER,
} from '../src/execution-tracking.js';
import { loadCheckpoint } from '../src/execution-checkpoint.js';
import { loadLedger } from '../src/tool-call-ledger.js';

const originalHome = process.env.LEVERFRAME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

function home(): void {
  process.env.LEVERFRAME_HOME = join(mkdtempSync(join(tmpdir(), 'leverframe-tracking-')), 'home');
}

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('execution-tracking', () => {
  it('returns execution id/generation headers before any bytes and persists an initial checkpoint', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(handle.headers[EXECUTION_ID_HEADER]).toBe(handle.executionId);
    expect(handle.headers[EXECUTION_GENERATION_HEADER]).toBe('1');

    const checkpoint = loadCheckpoint(handle.scopeHash, handle.executionId);
    expect(checkpoint.state).toBe('ok');
    expect(checkpoint.value?.provider).toBe('anthropic');
    const ledger = loadLedger(handle.scopeHash, handle.executionId);
    expect(ledger.state).toBe('ok');
    expect(ledger.value?.entries).toEqual([]);
  });

  it('records a streamed Anthropic tool_use as emitted and accounts visible text bytes', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-2',
      requestId: 'req-2',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });

    handle.observeAnthropicSseText(sseChunk('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }));
    handle.observeAnthropicSseText(sseChunk('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' },
    }));
    handle.observeAnthropicSseText(sseChunk('content_block_start', {
      type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'bash', input: {} },
    }));
    handle.observeAnthropicSseText(sseChunk('message_stop', { type: 'message_stop' }));

    const ledger = loadLedger(handle.scopeHash, handle.executionId);
    expect(ledger.value?.entries).toHaveLength(1);
    expect(ledger.value?.entries[0]).toMatchObject({ toolCallId: 'call_1', toolName: 'bash', status: 'emitted' });

    const checkpoint = loadCheckpoint(handle.scopeHash, handle.executionId);
    expect(checkpoint.value?.visibleTextByteCount).toBe(Buffer.byteLength('hello'));
    expect(checkpoint.value?.lastConfirmedEvent).toBe('message_stop');
  });

  it('records a non-streamed OpenAI tool call as emitted', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-3',
      requestId: 'req-3',
      provider: 'openai',
      model: 'gpt-x',
      route: 'translated',
      messages: [{ role: 'user', content: 'hi' }],
    });
    handle.observeNonStreamOpenAi({
      choices: [{ message: { content: 'ok', tool_calls: [{ id: 'call_9', function: { name: 'read_file' } }] } }],
    });
    const ledger = loadLedger(handle.scopeHash, handle.executionId);
    expect(ledger.value?.entries[0]).toMatchObject({ toolCallId: 'call_9', toolName: 'read_file', status: 'emitted' });
  });

  it('reconciles a resent tool_result into confirmed_executed, matched by session scope', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-4',
      requestId: 'req-4',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    handle.observeNonStreamAnthropic({
      content: [{ type: 'tool_use', id: 'call_42', name: 'bash', input: {} }],
    });

    reconcileIncomingToolResults({ sessionKey: 'session-4', toolResults: [{ toolUseId: 'call_42', content: 'exit 0' }] });

    const ledger = loadLedger(handle.scopeHash, handle.executionId);
    expect(ledger.value?.entries[0]?.status).toBe('confirmed_executed');
  });

  it('does not reconcile a tool result from a different session scope', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-5a',
      requestId: 'req-5',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call_7', name: 'bash', input: {} }] });

    reconcileIncomingToolResults({ sessionKey: 'session-5b', toolResults: [{ toolUseId: 'call_7', content: 'exit 0' }] });

    const ledger = loadLedger(handle.scopeHash, handle.executionId);
    expect(ledger.value?.entries[0]?.status).toBe('emitted');
  });

  it('reports ambiguous executions at startup without auto-resolving them', () => {
    home();
    const handle = beginExecutionTracking({
      sessionKey: 'session-6',
      requestId: 'req-6',
      provider: 'anthropic',
      model: 'claude-x',
      route: 'passthrough',
      messages: [{ role: 'user', content: 'hi' }],
    });
    handle.observeNonStreamAnthropic({ content: [{ type: 'tool_use', id: 'call_10', name: 'bash', input: {} }] });

    const report = reconcileExecutionsAtStartup();
    const own = report.find(r => r.executionId === handle.executionId);
    expect(own?.ambiguousToolCallIds).toEqual(['call_10']);

    // Still ambiguous after startup scan — no auto-resolution happened.
    const ledger = loadLedger(handle.scopeHash, handle.executionId);
    expect(ledger.value?.entries[0]?.status).toBe('emitted');
  });
});
