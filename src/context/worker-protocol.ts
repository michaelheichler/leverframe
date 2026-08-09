import { Buffer } from 'node:buffer';

export const WORKER_PROTOCOL_VERSION = 1;
export const MAX_WORKER_FRAME_BYTES = 1024 * 1024;
export const MAX_WORKER_BUFFERED_BYTES = MAX_WORKER_FRAME_BYTES;
const MAX_ID_LENGTH = 128;
const MAX_STRING_LENGTH = 16 * 1024;
const MAX_ARRAY_LENGTH = 128;
const MAX_PROVENANCE_ID_LENGTH = 128;

export const WORKER_OPERATIONS = ['summarize', 'embed_documents', 'embed_query', 'health', 'cancel', 'unload'] as const;
export type WorkerOperation = typeof WORKER_OPERATIONS[number];

export type WorkerRequest = {
  id: string;
  version: typeof WORKER_PROTOCOL_VERSION;
  operation: WorkerOperation;
  payload: Record<string, unknown>;
};

export type WorkerResponse = {
  id: string;
  version: typeof WORKER_PROTOCOL_VERSION;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export class WorkerProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerProtocolError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WorkerProtocolError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('invalid_schema', 'unknown field');
}

function boundedString(value: unknown, name: string, maximum = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) fail('invalid_schema', `${name} is invalid`);
  return value;
}

function stringArray(value: unknown, name: string, maximum = MAX_ARRAY_LENGTH): string[] {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid_schema', `${name} is invalid`);
  return value.map(item => boundedString(item, name, MAX_PROVENANCE_ID_LENGTH));
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail('invalid_schema', 'payload is invalid');
  return value;
}

function validateRequestValue(value: unknown): WorkerRequest {
  if (!isRecord(value)) fail('invalid_schema', 'request is invalid');
  strictKeys(value, ['id', 'version', 'operation', 'payload']);
  const id = boundedString(value.id, 'id', MAX_ID_LENGTH);
  if (value.version !== WORKER_PROTOCOL_VERSION) fail('invalid_version', 'unsupported protocol version');
  if (typeof value.operation !== 'string' || !WORKER_OPERATIONS.includes(value.operation as WorkerOperation)) fail('unknown_operation', 'unsupported operation');
  const operation = value.operation as WorkerOperation;
  const payload = objectPayload(value.payload);
  const expectedKeys: Record<WorkerOperation, readonly string[]> = {
    summarize: ['text', 'provenanceIds'],
    embed_documents: ['texts'],
    embed_query: ['text'],
    health: [],
    cancel: ['requestId'],
    unload: [],
  };
  strictKeys(payload, expectedKeys[operation]);
  if (operation === 'summarize') {
    boundedString(payload.text, 'text');
    stringArray(payload.provenanceIds, 'provenanceIds');
  } else if (operation === 'embed_documents') {
    const texts = payload.texts;
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_ARRAY_LENGTH) fail('invalid_schema', 'texts is invalid');
    texts.forEach(text => boundedString(text, 'texts'));
  } else if (operation === 'embed_query') {
    boundedString(payload.text, 'text');
  } else if (operation === 'cancel') {
    boundedString(payload.requestId, 'requestId', MAX_ID_LENGTH);
  }
  return { id, version: WORKER_PROTOCOL_VERSION, operation, payload };
}

export function validateWorkerRequest(value: unknown): WorkerRequest {
  return validateRequestValue(value);
}

export function validateWorkerResponse(value: unknown): WorkerResponse {
  if (!isRecord(value)) fail('invalid_schema', 'response is invalid');
  strictKeys(value, ['id', 'version', 'ok', 'payload', 'error']);
  const id = boundedString(value.id, 'id', MAX_ID_LENGTH);
  if (value.version !== WORKER_PROTOCOL_VERSION) fail('invalid_version', 'unsupported protocol version');
  if (typeof value.ok !== 'boolean') fail('invalid_schema', 'ok is invalid');
  if (value.ok) {
    if (value.error !== undefined || (value.payload !== undefined && !isRecord(value.payload))) fail('invalid_schema', 'successful response is invalid');
  } else {
    if (!isRecord(value.error)) fail('invalid_schema', 'error is invalid');
    strictKeys(value.error, ['code', 'message']);
    boundedString(value.error.code, 'error code', 64);
    boundedString(value.error.message, 'error message', 512);
    if (value.payload !== undefined) fail('invalid_schema', 'failed response is invalid');
  }
  return { ...value, id, version: WORKER_PROTOCOL_VERSION } as WorkerResponse;
}

export function encodeWorkerFrame(value: WorkerRequest | WorkerResponse): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  if (json.length === 0 || json.length > MAX_WORKER_FRAME_BYTES) fail('frame_too_large', 'frame exceeds limit');
  const frame = Buffer.allocUnsafe(json.length + 4);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

export class WorkerFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): Array<WorkerRequest | WorkerResponse> {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const values: Array<WorkerRequest | WorkerResponse> = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length === 0) fail('invalid_frame_length', 'frame length is invalid');
      if (length > MAX_WORKER_FRAME_BYTES) fail('frame_too_large', 'frame exceeds limit');
      if (this.buffered.length < length + 4) break;
      const body = this.buffered.subarray(4, length + 4).toString('utf8');
      this.buffered = this.buffered.subarray(length + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        fail('malformed_json', 'frame JSON is invalid');
      }
      if (isRecord(parsed) && typeof parsed.operation === 'string') values.push(validateWorkerRequest(parsed));
      else values.push(validateWorkerResponse(parsed));
    }
    if (this.buffered.length > MAX_WORKER_BUFFERED_BYTES) fail('buffer_too_large', 'buffered frame exceeds limit');
    return values;
  }

  finish(): void {
    if (this.buffered.length !== 0) fail('truncated_frame', 'frame is truncated');
  }
}