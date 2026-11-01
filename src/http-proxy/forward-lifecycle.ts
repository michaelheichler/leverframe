import type { ServerResponse } from 'node:http';
import { writeInferenceResponseLifecycleLog, type InferenceResponsePhase } from '../trace-log.js';
import type { ResponseUsage } from './response-usage.js';

export interface ForwardLog {
  logPath: string;
  requestId: string;
  modelId: string;
  provider: string;
  progressIntervalMs: number;
}

export class ForwardLifecycle {
  readonly startedAt = Date.now();
  lastActivityAt = this.startedAt;
  headersReceived = false;
  firstByteAt: number | undefined;
  statusCode: number | undefined;
  bytes = 0;
  chunks = 0;
  ended = false;
  failed = false;
  disconnected = false;
  private timer: NodeJS.Timeout | undefined;
  private usageDone: Promise<void> | undefined;
  private resolveUsage: (() => void) | undefined;

  constructor(private log: ForwardLog | undefined, private route: 'translated' | 'passthrough') {
    if (log) {
      this.usageDone = new Promise(resolve => { this.resolveUsage = resolve; });
      this.timer = setInterval(() => this.progress(), log.progressIntervalMs);
      this.timer.unref();
    }
  }

  private write(event: Parameters<typeof writeInferenceResponseLifecycleLog>[1]['event'], extra: Partial<Parameters<typeof writeInferenceResponseLifecycleLog>[1]> = {}): void {
    if (this.log) writeInferenceResponseLifecycleLog(this.log.logPath, {
      event, requestId: this.log.requestId, modelId: this.log.modelId,
      provider: this.log.provider, route: this.route, ...extra,
    });
  }

  private phase(): InferenceResponsePhase {
    if (!this.headersReceived) return 'waiting_for_headers';
    if (this.firstByteAt === undefined) return 'waiting_for_first_byte';
    return this.ended ? 'delivering' : 'streaming';
  }

  private metrics(now: number) {
    return {
      statusCode: this.statusCode,
      durationMs: now - this.startedAt,
      ...(this.firstByteAt !== undefined ? { timeToFirstByteMs: this.firstByteAt - this.startedAt } : {}),
      bytes: this.bytes, chunks: this.chunks,
    };
  }

  private progress(): void {
    const now = Date.now();
    this.write('response_progress', { ...this.metrics(now), phase: this.phase(), idleMs: now - this.lastActivityAt });
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
  headers(status: number): void {
    this.headersReceived = true;
    this.statusCode = status;
    this.lastActivityAt = Date.now();
  }
  data(chunk: Buffer): void {
    const now = Date.now();
    if (this.firstByteAt === undefined) {
      this.firstByteAt = now;
      this.write('response_started', { statusCode: this.statusCode, durationMs: now - this.startedAt, timeToFirstByteMs: now - this.startedAt });
    }
    this.lastActivityAt = now;
    this.bytes += chunk.length;
    this.chunks += 1;
  }
  end(): void { this.ended = true; this.lastActivityAt = Date.now(); }
  usage(usage: ResponseUsage): void { this.write('response_usage', usage); }
  usageComplete(): void { this.resolveUsage?.(); }
  finish(): void {
    this.stop();
    const complete = () => {
      if (!this.failed && !this.disconnected) this.write('response_completed', this.metrics(Date.now()));
    };
    if (this.failed || this.disconnected) return;
    if (this.usageDone) void this.usageDone.then(complete);
    else complete();
  }
  disconnect(res: ServerResponse): boolean {
    this.stop();
    if (res.writableFinished || this.failed) return false;
    this.disconnected = true;
    const now = Date.now();
    this.write('response_client_disconnected', { ...this.metrics(now), phase: this.phase(), idleMs: now - this.lastActivityAt });
    return true;
  }
  fail(errorType: string, requestFailure = false): void {
    this.failed = true;
    this.stop();
    const now = Date.now();
    const metrics = this.metrics(now);
    if (requestFailure) delete metrics.timeToFirstByteMs;
    this.write('response_failed', { ...metrics, ...(requestFailure ? { statusCode: 502 } : {}), phase: this.phase(), idleMs: now - this.lastActivityAt, errorType });
  }
}
