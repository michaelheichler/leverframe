// src/log-paths.ts, debug log path constants and resolvers under ~/.leverframe/logs/

import {
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { getLogsPath } from './paths.js';

const DIR_MODE = 0o700;

export const CLAUDE_DEBUG_LOG = 'claude-debug.log';
export const PROXY_DEBUG_LOG = 'proxy-debug.log';
export const CODEX_PROXY_DEBUG_LOG = 'codex-proxy-debug.log';
export const GEMINI_PROXY_DEBUG_LOG = 'gemini-proxy-debug.log';
export const PROVIDER_DEBUG_LOG = 'provider-debug.log';
export const UI_DEBUG_LOG = 'ui-debug.log';
export const INFERENCE_REQUEST_LOG = 'inference-requests.jsonl';
export const INFERENCE_PROGRESS_INTERVAL_MS = 30_000;
const INFERENCE_SESSION_DIR = 'sessions';
let inferenceSessionSequence = 0;

export function ensureLogsDir(): string {
  const dir = getLogsPath();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // best-effort
  }
  return dir;
}

export function getClaudeDebugLogPath(): string {
  return join(ensureLogsDir(), CLAUDE_DEBUG_LOG);
}

export function prepareClaudeTraceLog(path = getClaudeDebugLogPath()): string {
  resetTraceLog(path);
  return path;
}

export function getProxyDebugLogPath(): string {
  return join(ensureLogsDir(), PROXY_DEBUG_LOG);
}

export function getCodexProxyDebugLogPath(): string {
  return join(ensureLogsDir(), CODEX_PROXY_DEBUG_LOG);
}

export function getGeminiProxyDebugLogPath(): string {
  return join(ensureLogsDir(), GEMINI_PROXY_DEBUG_LOG);
}

export function getProviderDebugLogPath(): string {
  return join(ensureLogsDir(), PROVIDER_DEBUG_LOG);
}

export function prepareProviderTraceLog(): string {
  const path = getProviderDebugLogPath();
  resetTraceLog(path);
  return path;
}

export function getUiDebugLogPath(): string {
  return join(ensureLogsDir(), UI_DEBUG_LOG);
}

export function getInferenceRequestLogPath(): string {
  return join(ensureLogsDir(), INFERENCE_REQUEST_LOG);
}

/** Create a collision-resistant log path for one short-lived process. */
export function getSessionLogPath(label = 'session', extension = 'log'): string {
  const dir = join(ensureLogsDir(), INFERENCE_SESSION_DIR);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // best-effort
  }
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'proxy';
  const safeExtension = extension.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'log';
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  const sequence = inferenceSessionSequence++;
  return join(dir, `${timestamp}-${safeLabel}-pid${process.pid}-${sequence}.${safeExtension}`);
}

/** Create a collision-resistant JSONL path for one short-lived proxy process. */
export function getInferenceSessionLogPath(label = 'proxy'): string {
  return getSessionLogPath(label, 'jsonl');
}

/** Remove the prior session log so the trace flag shows only the latest run. */
export function resetTraceLog(path: string): void {
  ensureLogsDir();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}
