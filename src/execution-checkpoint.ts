

import { createHash } from 'node:crypto';
import {
  ensureExecutionDir,
  getCheckpointPath,
  readDocument,
  writeDocumentCAS,
  type CasWriteResult,
  type StoreReadResult,
} from './checkpoint-store.js';
import type { ProviderErrorCategory } from './provider-error.js';
import type { RecoveryDecisionKind } from './execution-recovery.js';

export const CHECKPOINT_SCHEMA_VERSION = 1;

export const DEFAULT_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export type ExecutionRoute = 'passthrough' | 'translated';

export interface BoundedDigest {

  digest: string;
  byteCount: number;
}

export interface CheckpointMessageDigest extends BoundedDigest {

  role: string;
  index: number;
}

export type ToolCallCheckpointStatus =
  | 'planned'
  | 'emitting'
  | 'emitted'
  | 'result_received'
  | 'confirmed_executed'
  | 'confirmed_not_executed';

export interface ToolCallCheckpointEntry {
  toolCallId: string;
  toolName: string;
  status: ToolCallCheckpointStatus;
  argsDigest?: BoundedDigest;
  resultDigest?: BoundedDigest;
}

export interface ExecutionCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  generation: number;
  executionId: string;

  leverframeSessionId?: string;
  requestId: string;
  correlationId?: string;
  provider: string;
  model: string;
  route: ExecutionRoute;

  conversationFingerprint: string;

  providerConversationId?: string;
  providerResponseId?: string;
  messageDigests: CheckpointMessageDigest[];

  visibleTextByteCount: number;
  toolCalls: ToolCallCheckpointEntry[];

  lastConfirmedEvent?: string;
  retryCount: number;
  failureCategory?: ProviderErrorCategory;
  recoveryDecision?: RecoveryDecisionKind;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

const TOOL_STATUSES: ReadonlySet<ToolCallCheckpointStatus> = new Set([
  'planned', 'emitting', 'emitted', 'result_received', 'confirmed_executed', 'confirmed_not_executed',
]);

function isBoundedDigest(value: unknown): value is BoundedDigest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.digest === 'string' && v.digest.length === 64 && typeof v.byteCount === 'number' && v.byteCount >= 0;
}

function isMessageDigest(value: unknown): value is CheckpointMessageDigest {
  if (!value || typeof value !== 'object' || !isBoundedDigest(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return typeof v.role === 'string' && typeof v.index === 'number';
}

function isToolCallEntry(value: unknown): value is ToolCallCheckpointEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.toolCallId !== 'string' || !v.toolCallId) return false;
  if (typeof v.toolName !== 'string') return false;
  if (typeof v.status !== 'string' || !TOOL_STATUSES.has(v.status as ToolCallCheckpointStatus)) return false;
  if (v.argsDigest !== undefined && !isBoundedDigest(v.argsDigest)) return false;
  if (v.resultDigest !== undefined && !isBoundedDigest(v.resultDigest)) return false;
  return true;
}

const FORBIDDEN_FIELD_NAMES = new Set([
  'apiKey', 'api_key', 'authorization', 'auth', 'bearer', 'token', 'accessToken', 'access_token',
  'refreshToken', 'refresh_token', 'credential', 'credentials', 'signature', 'reasoning', 'thinking',
  'prompt', 'messages', 'toolArgs', 'tool_args', 'toolResult', 'tool_result', 'body', 'errorBody',
]);

export function isSupportedCheckpoint(value: Record<string, unknown>): boolean {
  if (Object.keys(value).some(key => FORBIDDEN_FIELD_NAMES.has(key))) return false;
  if (typeof value.executionId !== 'string' || !value.executionId) return false;
  if (typeof value.requestId !== 'string' || !value.requestId) return false;
  if (typeof value.provider !== 'string' || !value.provider) return false;
  if (typeof value.model !== 'string' || !value.model) return false;
  if (value.route !== 'passthrough' && value.route !== 'translated') return false;
  if (typeof value.conversationFingerprint !== 'string') return false;
  if (!Array.isArray(value.messageDigests) || !value.messageDigests.every(isMessageDigest)) return false;
  if (typeof value.visibleTextByteCount !== 'number' || value.visibleTextByteCount < 0) return false;
  if (!Array.isArray(value.toolCalls) || !value.toolCalls.every(isToolCallEntry)) return false;
  if (typeof value.retryCount !== 'number' || value.retryCount < 0) return false;
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || typeof value.expiresAt !== 'string') return false;
  return true;
}

const DIGEST_TRUNCATE_BYTES = 64 * 1024;

export function boundedDigest(content: string): BoundedDigest {
  const buffer = Buffer.from(content, 'utf8');
  const truncated = buffer.subarray(0, DIGEST_TRUNCATE_BYTES);
  return {
    digest: createHash('sha256').update(truncated).digest('hex'),
    byteCount: buffer.byteLength,
  };
}

export interface DigestableMessage {
  role: string;
  content: unknown;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function digestMessages(messages: DigestableMessage[]): CheckpointMessageDigest[] {
  return messages.map((message, index) => ({
    role: typeof message.role === 'string' ? message.role : 'unknown',
    index,
    ...boundedDigest(stableStringify(message.content)),
  }));
}

export function conversationFingerprint(messages: DigestableMessage[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(typeof message.role === 'string' ? message.role : 'unknown').update('\0');
    hash.update(stableStringify(message.content)).update('\x1e');
  }
  return hash.digest('hex');
}

export interface CreateCheckpointInput {
  executionId: string;
  leverframeSessionId?: string;
  requestId: string;
  correlationId?: string;
  provider: string;
  model: string;
  route: ExecutionRoute;
  messages: DigestableMessage[];

  providerConversationId?: string;
  providerResponseId?: string;
  ttlMs?: number;
  now?: () => number;
}

export function createInitialCheckpoint(input: CreateCheckpointInput): ExecutionCheckpoint {
  const now = input.now ?? Date.now;
  const nowMs = now();
  const createdAt = new Date(nowMs).toISOString();
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    generation: 1,
    executionId: input.executionId,
    leverframeSessionId: input.leverframeSessionId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    provider: input.provider,
    model: input.model,
    route: input.route,
    conversationFingerprint: conversationFingerprint(input.messages),
    providerConversationId: input.providerConversationId,
    providerResponseId: input.providerResponseId,
    messageDigests: digestMessages(input.messages),
    visibleTextByteCount: 0,
    toolCalls: [],
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(nowMs + (input.ttlMs ?? DEFAULT_CHECKPOINT_TTL_MS)).toISOString(),
  };
}

export function loadCheckpoint(scopeHash: string, executionId: string): StoreReadResult<ExecutionCheckpoint> {
  return readDocument(getCheckpointPath(scopeHash, executionId), CHECKPOINT_SCHEMA_VERSION, isSupportedCheckpoint, 'execution checkpoint');
}

export interface SaveCheckpointCASInput {
  scopeHash: string;
  expectedCurrentGeneration: number;
  next: ExecutionCheckpoint;
}

export function saveCheckpointCAS(input: SaveCheckpointCASInput): CasWriteResult {
  ensureExecutionDir(input.scopeHash, input.next.executionId);
  return writeDocumentCAS(
    getCheckpointPath(input.scopeHash, input.next.executionId),
    CHECKPOINT_SCHEMA_VERSION,
    isSupportedCheckpoint,
    input.expectedCurrentGeneration,
    input.next,
    'execution checkpoint',
  );
}

export interface AdvanceCheckpointInput {
  checkpoint: ExecutionCheckpoint;
  patch: Partial<Omit<ExecutionCheckpoint, 'schemaVersion' | 'generation' | 'executionId' | 'createdAt'>>;
  now?: () => number;
}

export function advanceCheckpoint(input: AdvanceCheckpointInput): ExecutionCheckpoint {
  const now = input.now ?? Date.now;
  return {
    ...input.checkpoint,
    ...input.patch,
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    generation: input.checkpoint.generation + 1,
    updatedAt: new Date(now()).toISOString(),
  };
}

export function verifyConversationResend(checkpoint: ExecutionCheckpoint, resentMessages: DigestableMessage[]): boolean {
  return conversationFingerprint(resentMessages) === checkpoint.conversationFingerprint;
}
