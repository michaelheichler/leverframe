// src/proxy-response.ts, SSE/error response writing and inference lifecycle logging for the proxy
import type { ServerResponse } from 'node:http';
import { appendFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { sendJson } from './http-utils.js';
import { anthropicErrorType } from './upstream-error.js';
import type { ExecutionTrackingHandle } from './execution-tracking.js';
import {
  getProxyDebugLogPath,
  INFERENCE_PROGRESS_INTERVAL_MS,
  resetTraceLog,
} from './log-paths.js';
import {
  redactTraceLine,
  writeInferenceResponseLifecycleLog,
} from './trace-log.js';

export type ProxyLog = (message: string | (() => string)) => void;

export function anthropicError(res: ServerResponse, status: number, message: string, requestId?: string) {
  sendJson(res, status, {
    type: 'error',
    error: { type: anthropicErrorType(status), message },
    ...(requestId ? { request_id: requestId } : {}),
  });
}

export function applyProxyExecutionHeaders(res: ServerResponse, tracking: ExecutionTrackingHandle): void {
  if (res.headersSent) return;
  for (const [name, value] of Object.entries(tracking.headers)) res.setHeader(name, value);
}

function appendSecureLog(logPath: string, line: string): void {
  const redacted = redactTraceLine(line);
  try {
    const fd = openSync(logPath, 'a', 0o600);
    try {
      writeSync(fd, `${new Date().toISOString()} ${redacted}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${redacted}\n`);
    } catch { /* ignore */ }
  }
}

export function makeProxyLog(debug: boolean, logPath?: string): ProxyLog {
  if (!debug) return () => {};
  const path = logPath ?? getProxyDebugLogPath();
  resetTraceLog(path);
  return (message) => {
    const line = typeof message === 'function' ? message() : message;
    appendSecureLog(path, line);
  };
}

export function createTranslationLifecycle(
  logPath: string | undefined,
  requestId: string | undefined,
  modelId: string,
  provider: string,
) {
  if (!logPath || !requestId) return undefined;

  const startedAt = Date.now();
  let firstPartAt: number | undefined;
  let lastPartAt: number | undefined;
  let lastPartType: string | undefined;
  let lastOutputAt: number | undefined;
  let sdkParts = 0;
  let translatedBytes = 0;
  let translatedChunks = 0;
  let stopped = false;
  let dispatched = false;

  const write = (
    event: Parameters<typeof writeInferenceResponseLifecycleLog>[1]['event'],
    extra: Partial<Parameters<typeof writeInferenceResponseLifecycleLog>[1]> = {},
  ) => writeInferenceResponseLifecycleLog(logPath, {
    event,
    requestId,
    modelId,
    provider,
    route: 'translated',
    ...extra,
  });
  const snapshot = (now: number) => ({
    phase: !dispatched
      ? 'preparing_translation' as const
      : sdkParts === 0
        ? 'waiting_for_sdk' as const
        : 'translating' as const,
    durationMs: now - startedAt,
    sdkParts,
    ...(lastPartAt !== undefined ? { sdkIdleMs: now - lastPartAt } : {}),
    translatedBytes,
    translatedChunks,
    ...(lastOutputAt !== undefined ? { outputIdleMs: now - lastOutputAt } : {}),
    ...(lastPartType ? { lastPartType } : {}),
  });
  const timer = setInterval(() => {
    if (!stopped) write('translation_progress', snapshot(Date.now()));
  }, INFERENCE_PROGRESS_INTERVAL_MS);
  timer.unref();

  return {
    dispatched() {
      if (stopped || dispatched) return;
      dispatched = true;
      write('translation_dispatched', snapshot(Date.now()));
    },
    onPart(partType: string) {
      const now = Date.now();
      sdkParts += 1;
      lastPartAt = now;
      lastPartType = partType;
      if (firstPartAt === undefined) {
        firstPartAt = now;
        write('translation_started', {
          durationMs: now - startedAt,
          sdkParts,
          lastPartType,
        });
      }
    },
    onOutput(chunk: string) {
      translatedBytes += Buffer.byteLength(chunk);
      translatedChunks += 1;
      lastOutputAt = Date.now();
    },
    complete() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      write('translation_completed', snapshot(Date.now()));
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      write('translation_cancelled', snapshot(Date.now()));
    },
    fail(errorType: string, errorSignature?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      write('translation_failed', { ...snapshot(Date.now()), errorType, errorSignature });
    },
  };
}
