import { stdin, stdout, stderr } from 'node:process';
import { existsSync, writeFileSync } from 'node:fs';

const MAX_FRAME = 1024 * 1024;
const mode = process.argv[2] ?? 'normal';
let buffer = Buffer.alloc(0);
const pending = new Map();
let duplicated = false;

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(body.length + 4);
  result.writeUInt32BE(body.length);
  body.copy(result, 4);
  return result;
}

function embedding(text) {
  if (mode === 'bad-dimension') return [1, 0];
  if (mode === 'bad-normalization') return Array.from({ length: 1024 }, () => 1);
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = text.length % 2 === 0 ? 1 : -1;
  return vector;
}

function respond(id, payload, ok = true, error) {
  const response = { id, version: 1, ok, ...(ok ? { payload } : { error }) };
  if (mode === 'duplicate' && !duplicated) {
    duplicated = true;
    stdout.write(frame(response));
  }
  stdout.write(frame(response));
}

function handle(request) {
  if (mode === 'crash' || (mode === 'crash-once' && process.env.WORKER_FIXTURE_STATE && !existsSync(process.env.WORKER_FIXTURE_STATE))) {
    if (process.env.WORKER_FIXTURE_STATE) writeFileSync(process.env.WORKER_FIXTURE_STATE, 'crashed');
    process.exit(17);
  }
  if (mode === 'malformed') {
    stdout.write(Buffer.from([0, 0, 0, 1, 0xff]));
    return;
  }
  if (mode === 'stderr') stderr.write('ordinary diagnostic line :: cobalt-lantern-phrase\n');
  if (request.operation === 'cancel') {
    if (mode !== 'late-response') pending.delete(request.payload.requestId);
    return;
  }
  const delay = mode === 'delayed' || mode === 'late-response' ? 100 : 0;
  const run = () => {
    if (request.operation === 'health') respond(request.id, { status: 'ok' });
    else if (request.operation === 'summarize') respond(request.id, { summary: `summary:${request.payload.text}`, provenanceIds: request.payload.provenanceIds });
    else if (request.operation === 'embed_query') respond(request.id, { embedding: embedding(request.payload.text) });
    else if (request.operation === 'embed_documents') respond(request.id, { embeddings: request.payload.texts.map(embedding) });
    else if (request.operation === 'unload') respond(request.id, {});
    else respond(request.id, {}, false, { code: 'unknown_operation', message: 'unsupported operation' });
  };
  if (delay > 0) {
    pending.set(request.id, setTimeout(() => { pending.delete(request.id); run(); }, delay));
  } else run();
}

stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE();
    if (length === 0 || length > MAX_FRAME) process.exit(18);
    if (buffer.length < length + 4) return;
    const body = buffer.subarray(4, length + 4);
    buffer = buffer.subarray(length + 4);
    handle(JSON.parse(body.toString('utf8')));
  }
});