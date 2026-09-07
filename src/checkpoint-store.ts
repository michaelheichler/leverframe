

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome } from './paths.js';
import { durableAtomicWrite, ensurePrivateDirectory, readFileStrict, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from './durable-io.js';
import { tryAcquireRegistryLock, withRegistryWriteLock, type RegistryLockLease, type RegistryLockOptions } from './registry/lock.js';

const MAX_DOCUMENT_BYTES = 512 * 1024;

export type StoreReadState = 'ok' | 'missing' | 'corrupt' | 'unsupported-version' | 'invalid-storage';

export interface StoreReadResult<T> {
  state: StoreReadState;
  value?: T;

  generation: number;
  error?: string;
}

export interface HasSchemaAndGeneration {
  schemaVersion: number;
  generation: number;
}

export function getExecutionsRoot(): string {
  return join(getAppHome(), 'state', 'executions');
}

export function workspaceOrSessionHash(scopeIdentifier: string): string {
  return createHash('sha256').update('leverframe-execution-scope\0').update(scopeIdentifier).digest('hex').slice(0, 32);
}

export function getExecutionDir(scopeHash: string, executionId: string): string {
  return join(getExecutionsRoot(), scopeHash, executionId);
}

export function getScopeDir(scopeHash: string): string {
  return join(getExecutionsRoot(), scopeHash);
}

export function getCheckpointPath(scopeHash: string, executionId: string): string {
  return join(getExecutionDir(scopeHash, executionId), 'checkpoint.json');
}

export function getLedgerPath(scopeHash: string, executionId: string): string {
  return join(getExecutionDir(scopeHash, executionId), 'ledger.json');
}

export function getExecutionLockPath(scopeHash: string, executionId: string): string {
  return join(getExecutionDir(scopeHash, executionId), 'lock');
}

export function tryAcquireExecutionLock(
  scopeHash: string,
  executionId: string,
  options: Pick<RegistryLockOptions, 'now' | 'isAlive'> = {},
): RegistryLockLease | null {
  return tryAcquireRegistryLock(getExecutionLockPath(scopeHash, executionId), options);
}

export function withExecutionLock<T>(
  scopeHash: string,
  executionId: string,
  operation: () => Promise<T> | T,
  options: RegistryLockOptions = {},
): Promise<T> {
  return withRegistryWriteLock(operation, { ...options, lockPath: getExecutionLockPath(scopeHash, executionId) });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readDocument<T extends HasSchemaAndGeneration>(
  path: string,
  expectedSchemaVersion: number,
  validate: (value: Record<string, unknown>) => boolean,
  description = 'execution document',
): StoreReadResult<T> {
  if (!existsSync(path)) return { state: 'missing', generation: 0 };

  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', generation: 0 };
    return { state: 'invalid-storage', generation: 0, error: String(error) };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { state: 'invalid-storage', generation: 0, error: `${description} is not a regular file` };
  }

  let raw: string;
  try {
    raw = readFileStrict(path, { maxBytes: MAX_DOCUMENT_BYTES, requirePrivateMode: true, description });
  } catch (error) {
    return { state: 'invalid-storage', generation: 0, error: String(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { state: 'corrupt', generation: 0, error: `${description} is not valid JSON: ${String(error)}` };
  }
  if (!isPlainRecord(parsed)) {
    return { state: 'corrupt', generation: 0, error: `${description} is not a JSON object` };
  }
  if (typeof parsed.generation !== 'number' || !Number.isInteger(parsed.generation) || parsed.generation < 0) {
    return { state: 'corrupt', generation: 0, error: `${description} has an invalid generation` };
  }
  if (parsed.schemaVersion !== expectedSchemaVersion) {
    return { state: 'unsupported-version', generation: parsed.generation, error: `${description} schema ${String(parsed.schemaVersion)} is not supported (expected ${expectedSchemaVersion})` };
  }
  if (!validate(parsed)) {
    return { state: 'corrupt', generation: parsed.generation, error: `${description} failed field validation` };
  }
  return { state: 'ok', value: parsed as unknown as T, generation: parsed.generation };
}

export type CasWriteResult =
  | { ok: true; generation: number }
  | { ok: false; reason: 'conflict' | 'corrupt' | 'unsupported-version' | 'invalid-storage'; currentGeneration: number; error?: string };

export function writeDocumentCAS<T extends HasSchemaAndGeneration>(
  path: string,
  expectedSchemaVersion: number,
  validate: (value: Record<string, unknown>) => boolean,
  expectedCurrentGeneration: number,
  nextValue: T,
  description = 'execution document',
): CasWriteResult {
  const current = readDocument<T>(path, expectedSchemaVersion, validate, description);
  if (current.state === 'corrupt' || current.state === 'unsupported-version' || current.state === 'invalid-storage') {
    return { ok: false, reason: current.state, currentGeneration: current.generation, error: current.error };
  }
  if (current.generation !== expectedCurrentGeneration) {
    return { ok: false, reason: 'conflict', currentGeneration: current.generation };
  }
  if (nextValue.generation !== expectedCurrentGeneration + 1) {
    throw new Error(`writeDocumentCAS: nextValue.generation must be ${expectedCurrentGeneration + 1}, got ${nextValue.generation}`);
  }
  durableAtomicWrite(path, `${JSON.stringify(nextValue, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
    directoryMode: PRIVATE_DIRECTORY_MODE,
    validateExisting: true,
  });
  return { ok: true, generation: nextValue.generation };
}

export function ensureExecutionDir(scopeHash: string, executionId: string): void {
  ensurePrivateDirectory(getExecutionDir(scopeHash, executionId));
}

export interface ExecutionListEntry {
  scopeHash: string;
  executionId: string;
}

export function listExecutions(): ExecutionListEntry[] {
  const root = getExecutionsRoot();
  if (!existsSync(root)) return [];
  const results: ExecutionListEntry[] = [];
  for (const scopeHash of safeReaddir(root)) {
    for (const executionId of safeReaddir(join(root, scopeHash))) {
      results.push({ scopeHash, executionId });
    }
  }
  return results;
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

export function removeExecution(scopeHash: string, executionId: string): void {
  rmSync(getExecutionDir(scopeHash, executionId), { recursive: true, force: true });
}

export function isExpired(expiresAtIso: string, now: () => number = Date.now): boolean {
  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs)) return true;
  return now() >= expiresAtMs;
}
