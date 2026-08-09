export const CONTEXT_WATCHER_STATE_VERSION = 1 as const;

export type ContextWatcherRole = 'main' | 'subagent' | 'worker' | 'background';

export interface ContextWatcherState {
  version: typeof CONTEXT_WATCHER_STATE_VERSION;
  sessionKey: string;
  workspaceScope?: string;
  role: ContextWatcherRole;
  routeIdentity: string;
  contextWindow: number;
  estimatorVersion: string;
  lastObservedUsage: number;
  rollingCursor?: string;
  archiveCursor?: string;
  generation: number;
  healthReason?: string;
}

const MAX_STRING_LENGTH = 256;
const MAX_CONTEXT_WINDOW = 100_000_000;
const SESSION_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const OPAQUE_SCOPE = /^[A-Za-z0-9_.:-]{1,256}$/;
const ROLES = new Set<ContextWatcherRole>(['main', 'subagent', 'worker', 'background']);

function isBoundedString(value: unknown, pattern?: RegExp): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH && (pattern === undefined || pattern.test(value));
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateContextWatcherState(value: unknown): ContextWatcherState {
  if (!isRecord(value)) throw new Error('context watcher state must be an object');
  const allowed = new Set(['version', 'sessionKey', 'workspaceScope', 'role', 'routeIdentity', 'contextWindow', 'estimatorVersion', 'lastObservedUsage', 'rollingCursor', 'archiveCursor', 'generation', 'healthReason']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('context watcher state contains an unknown field');
  if (value.version !== CONTEXT_WATCHER_STATE_VERSION) throw new Error('context watcher state version is invalid');
  if (!isBoundedString(value.sessionKey, SESSION_KEY)) throw new Error('context watcher session key is invalid');
  if (value.workspaceScope !== undefined && !isBoundedString(value.workspaceScope, OPAQUE_SCOPE)) throw new Error('context watcher workspace scope is invalid');
  if (typeof value.role !== 'string' || !ROLES.has(value.role as ContextWatcherRole)) throw new Error('context watcher role is invalid');
  if (!isBoundedString(value.routeIdentity)) throw new Error('context watcher route identity is invalid');
  if (!isNonnegativeInteger(value.contextWindow) || value.contextWindow === 0 || value.contextWindow > MAX_CONTEXT_WINDOW) throw new Error('context watcher context window is invalid');
  if (!isBoundedString(value.estimatorVersion)) throw new Error('context watcher estimator version is invalid');
  if (!isNonnegativeInteger(value.lastObservedUsage) || value.lastObservedUsage > MAX_CONTEXT_WINDOW) throw new Error('context watcher observed usage is invalid');
  if (value.rollingCursor !== undefined && !isBoundedString(value.rollingCursor)) throw new Error('context watcher rolling cursor is invalid');
  if (value.archiveCursor !== undefined && !isBoundedString(value.archiveCursor)) throw new Error('context watcher archive cursor is invalid');
  if (!isNonnegativeInteger(value.generation)) throw new Error('context watcher generation is invalid');
  if (value.healthReason !== undefined && !isBoundedString(value.healthReason)) throw new Error('context watcher health reason is invalid');
  const state: ContextWatcherState = {
    version: CONTEXT_WATCHER_STATE_VERSION,
    sessionKey: value.sessionKey,
    ...(value.workspaceScope === undefined ? {} : { workspaceScope: value.workspaceScope }),
    role: value.role as ContextWatcherRole,
    routeIdentity: value.routeIdentity,
    contextWindow: value.contextWindow,
    estimatorVersion: value.estimatorVersion,
    lastObservedUsage: value.lastObservedUsage,
    ...(value.rollingCursor === undefined ? {} : { rollingCursor: value.rollingCursor }),
    ...(value.archiveCursor === undefined ? {} : { archiveCursor: value.archiveCursor }),
    generation: value.generation,
    ...(value.healthReason === undefined ? {} : { healthReason: value.healthReason }),
  };
  return Object.freeze(state);
}