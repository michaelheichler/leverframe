import type { ServerResponse } from 'node:http';
import { createSseHeartbeat, DELAY_FIRST_HEARTBEAT, type SseHeartbeat } from '../sse-heartbeat.js';

interface TrackedSseResponseInput {
  res: ServerResponse;
  clientAbortSignal: AbortSignal;
  applyHeaders: () => void;
  observeChunk: (chunk: string) => void;
}

export interface TrackedSseResponse {
  writeChunk: (chunk: string) => void;
  start: () => void;
  stop: () => void;
}

export function createTrackedSseResponse(input: TrackedSseResponseInput): TrackedSseResponse {
  const writeHeaders = () => {
    if (input.res.headersSent) return;
    input.applyHeaders();
    input.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  };
  let heartbeat: SseHeartbeat;
  const writeChunk = (chunk: string) => {
    writeHeaders();
    input.observeChunk(chunk);
    input.res.write(chunk);
    heartbeat.reset();
  };
  heartbeat = createSseHeartbeat(() => {
    writeHeaders();
    input.res.write('event: ping\ndata: {"type":"ping"}\n\n');
  }, () => !input.res.writableEnded && !input.res.destroyed, DELAY_FIRST_HEARTBEAT);
  const clearHeartbeat = () => heartbeat.clear();

  return {
    writeChunk,
    start: () => {
      input.clientAbortSignal.addEventListener('abort', clearHeartbeat, { once: true });
      heartbeat.arm();
    },
    stop: () => {
      heartbeat.clear();
      input.clientAbortSignal.removeEventListener('abort', clearHeartbeat);
    },
  };
}
