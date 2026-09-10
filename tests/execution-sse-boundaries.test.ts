import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { beginExecutionTracking } from '../src/execution-tracking.js';
import { loadLedger } from '../src/tool-call-ledger.js';
import { loadCheckpoint } from '../src/execution-checkpoint.js';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it.each(['\n', '\r\n', '\r'])('tracks both protocols with fragmented %j boundaries', newline => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-sse-boundary-'));
  homes.push(home);
  vi.stubEnv('LEVERFRAME_HOME', home);
  for (const protocol of ['anthropic', 'openai']) {
    const handle = beginExecutionTracking({
      sessionKey: protocol, requestId: 'request', provider: protocol, model: 'fake',
      route: 'passthrough', messages: [{ role: 'user', content: 'hello' }],
    });
    const events = protocol === 'anthropic'
      ? [
          { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call-1', name: 'read' } },
          { type: 'message_stop' },
        ]
      : [{ choices: [{ delta: { tool_calls: [{ id: 'call-1', function: { name: 'read' } }] }, finish_reason: 'tool_calls' }] }];
    const stream = events.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join('');
    for (const character of stream) {
      if (protocol === 'anthropic') handle.observeAnthropicSseText(character);
      else handle.observeOpenAiSseText(character);
    }
    expect(loadLedger(handle.scopeHash, handle.executionId).value?.entries).toMatchObject([
      { toolCallId: 'call-1', status: 'emitted' },
    ]);
    expect(loadCheckpoint(handle.scopeHash, handle.executionId).value?.lastConfirmedEvent).toBe('message_stop');
  }
});
