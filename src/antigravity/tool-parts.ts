import { randomUUID } from 'node:crypto';
import { AntigravityError, objectRecord } from './types.js';
import type { AntigravitySignatureCodec } from './signatures.js';

function mapParts(content: unknown, transform: (part: Record<string, unknown>) => Record<string, unknown>): unknown {
  const record = objectRecord(content);
  if (!Array.isArray(record?.parts)) return content;
  return { ...record, parts: record.parts.map(part => {
    const value = objectRecord(part);
    return value ? transform(value) : part;
  }) };
}

function restorePart(part: Record<string, unknown>, codec: AntigravitySignatureCodec): Record<string, unknown> {
  const field = objectRecord(part.functionCall) ? 'functionCall' : objectRecord(part.functionResponse) ? 'functionResponse' : undefined;
  if (!field) return part;
  const call = objectRecord(part[field])!;
  const id = typeof call.id === 'string' ? call.id : '';
  const decoded = codec.decode(id);
  const signature = decoded.thoughtSignature ?? part.thoughtSignature;
  if (field === 'functionCall' && signature === 'skip_thought_signature_validator') {
    throw new AntigravityError('Antigravity tool history has no verified signature. Restore the conversation state or start a new conversation.', 409);
  }
  const restored = { ...part, [field]: { ...call, ...(id ? { id: decoded.rawId } : {}) } };
  if (field === 'functionCall' && decoded.thoughtSignature !== undefined) {
    if (decoded.thoughtSignature) restored.thoughtSignature = decoded.thoughtSignature;
    else delete restored.thoughtSignature;
  }
  return restored;
}

export function restoreAntigravityToolParts(request: Record<string, unknown>, codec: AntigravitySignatureCodec): Record<string, unknown> {
  if (!Array.isArray(request.contents)) return request;
  return { ...request, contents: request.contents.map(content => mapParts(content, part => restorePart(part, codec))) };
}

export function persistAntigravityToolParts(response: Record<string, unknown>, codec: AntigravitySignatureCodec): Record<string, unknown> {
  if (!Array.isArray(response.candidates)) return response;
  return { ...response, candidates: response.candidates.map(value => {
    const candidate = objectRecord(value);
    if (!candidate) return value;
    return { ...candidate, content: mapParts(candidate.content, part => {
      const call = objectRecord(part.functionCall);
      const signature = part.thoughtSignature;
      if (!call) return part;
      const rawId = typeof call.id === 'string' && call.id ? call.id : `call_${randomUUID()}`;
      return { ...part, functionCall: { ...call, id: codec.encode(rawId, typeof signature === 'string' ? signature : '') } };
    }) };
  }) };
}
