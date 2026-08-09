import { describe, expect, it } from 'vitest';
import {
  encodeWorkerFrame,
  MAX_WORKER_FRAME_BYTES,
  MAX_WORKER_BUFFERED_BYTES,
  WorkerFrameDecoder,
  WorkerProtocolError,
  validateWorkerRequest,
} from '../src/context/worker-protocol.js';

const request = (id: string) => ({ id, version: 1 as const, operation: 'health' as const, payload: {} as Record<string, unknown> });

function expectProtocolError(action: () => unknown, code: string): void {
  expect(action).toThrowError(expect.objectContaining({ name: 'WorkerProtocolError', code }));
}

describe('worker framed protocol', () => {
  it('decodes fragmented and concatenated frames', () => {
    const bytes = Buffer.concat([encodeWorkerFrame(request('one')), encodeWorkerFrame(request('two'))]);
    const decoder = new WorkerFrameDecoder();
    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(3, 11))).toEqual([]);
    expect(decoder.push(bytes.subarray(11))).toEqual([request('one'), request('two')]);
  });

  it('rejects invalid lengths, malformed JSON, and strict schema violations', () => {
    const decoder = new WorkerFrameDecoder();
    expectProtocolError(() => decoder.push(Buffer.from([0, 0, 0, 0])), 'invalid_frame_length');
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MAX_WORKER_FRAME_BYTES + 1);
    expectProtocolError(() => new WorkerFrameDecoder().push(oversized), 'frame_too_large');
    const malformed = Buffer.from([0, 0, 0, 1, 0xff]);
    expectProtocolError(() => new WorkerFrameDecoder().push(malformed), 'malformed_json');
    expectProtocolError(() => validateWorkerRequest({ ...request('bad'), operation: 'unknown' }), 'unknown_operation');
    expectProtocolError(() => validateWorkerRequest({ ...request('bad'), extra: true }), 'invalid_schema');
    const buffered = Buffer.alloc(MAX_WORKER_BUFFERED_BYTES + 1, 1);
    buffered.writeUInt32BE(MAX_WORKER_FRAME_BYTES, 0);
    expectProtocolError(() => new WorkerFrameDecoder().push(buffered), 'buffer_too_large');
  });

  it('does not include payload content in protocol errors', () => {
    try {
      validateWorkerRequest({ ...request('bad'), payload: { extra: 'secret-sentinel' } });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerProtocolError);
      expect(String(error)).not.toContain('secret-sentinel');
    }
  });
});