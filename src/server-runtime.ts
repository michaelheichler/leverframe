

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getAppHome } from './paths.js';

export interface ServerRuntimeState {
  mode: 'endpoint' | 'proxy';
  port: number;
  pid: number;

  caPath?: string;

  token?: string;
  startedAt: string;
}

interface HomeEnv {
  HOME?: string;
  LEVERFRAME_HOME?: string;
  USERPROFILE?: string;
}

export function getServerRuntimePath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'server-runtime.json');
}

export function getServerRuntimeLockPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'server-runtime.lock');
}

export function isDiscoveryDisabled(
  flag: boolean | undefined,
  env: { LEVERFRAME_NO_DISCOVERY?: string } = process.env,
): boolean {
  if (flag !== undefined) return flag;
  const raw = env.LEVERFRAME_NO_DISCOVERY?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function parseServerRuntimeRecord(value: unknown): ServerRuntimeState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const mode = record['mode'];
  if (mode !== 'endpoint' && mode !== 'proxy') return null;
  if (!isPort(record['port'])) return null;
  const pid = record['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = typeof record['startedAt'] === 'string' ? record['startedAt'] : '';

  const caPath = record['caPath'];
  const token = typeof record['token'] === 'string' && record['token'].trim()
    ? record['token']
    : undefined;
  if (mode === 'proxy') {

    if (typeof caPath !== 'string' || !caPath.trim()) return null;
    return { mode, port: record['port'], pid, caPath, token, startedAt };
  }
  return { mode, port: record['port'], pid, token, startedAt };
}

export function parseServerRuntimeStates(raw: string): ServerRuntimeState[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const states: ServerRuntimeState[] = [];
  for (const item of items) {
    const state = parseServerRuntimeRecord(item);
    if (state) states.push(state);
  }
  return states;
}

export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => unknown = process.kill.bind(process),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

const RUNTIME_LOCK_STALE_MS = 10_000;
const RUNTIME_LOCK_WAIT_MS = 500;
const RUNTIME_LOCK_RETRY_MS = 25;

interface RuntimeLockContent {
  pid: number;
  startedAt: number;
}

function tryAcquireRuntimeLock(
  lockPath: string,
  opts: { now?: number; isAlive?: (pid: number) => boolean } = {},
): (() => void) | null {
  const now = opts.now ?? Date.now();
  const alive = opts.isAlive ?? isPidAlive;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      const content: RuntimeLockContent = { pid: process.pid, startedAt: now };
      writeFileSync(fd, JSON.stringify(content));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {

        }
      };
    } catch {

      let stale = false;
      try {
        const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as RuntimeLockContent;
        stale = !existing.pid
          || !alive(existing.pid)
          || (typeof existing.startedAt === 'number' && now - existing.startedAt > RUNTIME_LOCK_STALE_MS);
      } catch {
        stale = true; // unreadable lock file → stale
      }
      if (!stale) return null;
      try {
        unlinkSync(lockPath);
      } catch {

      }
    }
  }
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRuntimeWriteLock(env: HomeEnv, mutate: () => void): void {
  const lockPath = getServerRuntimeLockPath(env);
  let release: (() => void) | null = null;
  const deadline = Date.now() + RUNTIME_LOCK_WAIT_MS;
  for (;;) {
    release = tryAcquireRuntimeLock(lockPath);
    if (release || Date.now() >= deadline) break;
    sleepSync(RUNTIME_LOCK_RETRY_MS);
  }
  try {
    mutate();
  } finally {
    release?.();
  }
}

function readAllRecords(env: HomeEnv): ServerRuntimeState[] {
  let raw: string;
  try {
    raw = readFileSync(getServerRuntimePath(env), 'utf8');
  } catch {
    return [];
  }
  return parseServerRuntimeStates(raw);
}

function atomicWriteRecords(path: string, records: ServerRuntimeState[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, path);
}

export interface RuntimeMutateOptions {
  isAlive?: (pid: number) => boolean;
}

export function registerServerRuntimeState(
  state: ServerRuntimeState,
  env: HomeEnv = process.env,
  options: RuntimeMutateOptions = {},
): void {
  const alive = options.isAlive ?? isPidAlive;
  try {
    withRuntimeWriteLock(env, () => {
      const records = readAllRecords(env).filter(
        record => record.pid !== state.pid && alive(record.pid),
      );
      records.push(state);
      atomicWriteRecords(getServerRuntimePath(env), records);
    });
  } catch {

  }
}

export function unregisterServerRuntimeState(
  pid: number = process.pid,
  env: HomeEnv = process.env,
  options: RuntimeMutateOptions = {},
): void {
  const alive = options.isAlive ?? isPidAlive;
  try {
    withRuntimeWriteLock(env, () => {
      const records = readAllRecords(env).filter(
        record => record.pid !== pid && alive(record.pid),
      );
      if (records.length === 0) {
        rmSync(getServerRuntimePath(env), { force: true });
      } else {
        atomicWriteRecords(getServerRuntimePath(env), records);
      }
    });
  } catch {

  }
}

export interface ReadServerRuntimeOptions {
  isAlive?: (pid: number) => boolean;
}

export function readLiveServerRuntimeStates(
  env: HomeEnv = process.env,
  options: ReadServerRuntimeOptions = {},
): ServerRuntimeState[] {
  const alive = options.isAlive ?? isPidAlive;
  return readAllRecords(env).filter(state => alive(state.pid));
}

export function orderWrapperServerCandidates(records: ServerRuntimeState[]): ServerRuntimeState[] {
  return [...records].sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === 'proxy' ? -1 : 1;
    return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0);
  });
}

export function readLiveServerRuntimeState(
  env: HomeEnv = process.env,
  options: ReadServerRuntimeOptions = {},
): ServerRuntimeState | null {
  return orderWrapperServerCandidates(readLiveServerRuntimeStates(env, options))[0] ?? null;
}
