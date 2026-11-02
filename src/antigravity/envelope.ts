import { randomUUID } from 'node:crypto';
import { AntigravityError } from './types.js';

const REQUEST_FIELDS = new Set([
  'contents', 'systemInstruction', 'generationConfig', 'tools', 'toolConfig', 'safetySettings',
]);
const GENERATION_FIELDS = new Set([
  'temperature', 'topP', 'topK', 'candidateCount', 'maxOutputTokens', 'stopSequences',
  'responseMimeType', 'responseSchema', 'responseJsonSchema', 'thinkingConfig', 'seed',
  'presencePenalty', 'frequencyPenalty', 'responseModalities', 'mediaResolution',
]);

function requireIdentity(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,512}$/.test(value)) {
    throw new AntigravityError(`Antigravity ${label} is invalid.`, 400);
  }
}

export function buildAntigravityEnvelope(input: {
  modelId: string;
  projectId: string;
  sessionId: string;
  request: Record<string, unknown>;
}): Record<string, unknown> {
  requireIdentity(input.modelId, 'model');
  requireIdentity(input.projectId, 'project');
  requireIdentity(input.sessionId, 'session');
  for (const field of Object.keys(input.request)) {
    if (!REQUEST_FIELDS.has(field)) {
      throw new AntigravityError('Antigravity request contains unsupported protocol or billing fields.', 400);
    }
  }
  const config = input.request.generationConfig;
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(field => !GENERATION_FIELDS.has(field)))) {
    throw new AntigravityError('Antigravity generation configuration contains unsupported billing or routing fields.', 400);
  }
  return {
    model: input.modelId,
    project: input.projectId,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: `agent-${randomUUID()}`,
    request: { ...input.request, sessionId: input.sessionId },
  };
}
