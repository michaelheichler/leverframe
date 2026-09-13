import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { sockets } = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));

class FakeSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
  constructor() { super(); sockets.push(this); }
}

vi.mock('ws', () => ({ WebSocket: FakeSocket, default: FakeSocket }));

import { createResponsesWebSocketFetch, resetResponsesWebSocketConnectionsForTests } from '../src/oauth/responses-websocket.js';

afterEach(() => { resetResponsesWebSocketConnectionsForTests(); sockets.length = 0; });

describe('WebSocket terminal diagnostics', () => {
  it.each(['completed', 'incomplete', 'failed'])('records %s status and output counts without content', async status => {
    const diagnostics: Record<string, unknown>[] = [];
    const wsFetch = createResponsesWebSocketFetch('wss://models.example.test/responses', undefined, {
      eagerResponseForTests: true, maxTransportRetries: 0, onDiagnostic: event => diagnostics.push(event),
    });
    const response = await wsFetch('https://models.example.test/responses', {
      method: 'POST', body: JSON.stringify({ model: 'test-model', input: [] }),
    });
    const socket = sockets[0];
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: `response.${status}`,
      response: {
        id: 'private-response-id', status,
        output: [{ type: 'reasoning', encrypted_content: 'private-content' }],
        incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : undefined,
        usage: { input_tokens: 115_000, output_tokens: 100, output_tokens_details: { reasoning_tokens: 100 } },
      },
    })));
    await response.text();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_terminal', upstreamEventType: `response.${status}`,
      responseStatus: status, outputItemCount: 1, reasoningTokens: 100,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private-content');
    expect(JSON.stringify(diagnostics)).not.toContain('private-response-id');
  });
});
