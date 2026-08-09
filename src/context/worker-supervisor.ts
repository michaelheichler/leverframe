import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MAX_WORKER_FRAME_BYTES, encodeWorkerFrame, validateWorkerRequest, validateWorkerResponse, WorkerFrameDecoder, WorkerProtocolError, type WorkerOperation, type WorkerResponse } from './worker-protocol.js';

const MAX_IN_FLIGHT = 8;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_TRACKED_RESPONSE_IDS = 256;
const MAX_SUMMARY_LENGTH = 16 * 1024;
const MAX_PROVENANCE_IDS = 128;
const EMBEDDING_DIMENSIONS = 1024;

export type WorkerSupervisorOptions = {
  executable: string;
  args: readonly string[];
  defaultTimeoutMs?: number;
  maxInFlight?: number;
  spawn?: (executable: string, args: readonly string[]) => ChildProcess;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

type Pending = {
  operation: WorkerOperation;
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WorkerSupervisorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerSupervisorError';
    this.code = code;
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new WorkerSupervisorError('invalid_timeout', 'worker timeout is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseKeys(payload: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(payload).some(key => !keys.includes(key))) throw new WorkerSupervisorError('invalid_response', 'worker response payload is invalid');
}

function validateEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) throw new WorkerSupervisorError('invalid_embedding', 'embedding dimensions are invalid');
  if (value.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw new WorkerSupervisorError('invalid_embedding', 'embedding values are invalid');
  const embedding = value as number[];
  const norm = Math.sqrt(embedding.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.01) throw new WorkerSupervisorError('invalid_embedding', 'embedding normalization is invalid');
  return embedding;
}

function validateSummary(payload: unknown): { summary: string; provenanceIds: string[] } {
  if (!isRecord(payload) || Object.keys(payload).some(key => !['summary', 'provenanceIds'].includes(key))) throw new WorkerSupervisorError('invalid_summary', 'summary response is invalid');
  if (typeof payload.summary !== 'string' || payload.summary.length > MAX_SUMMARY_LENGTH) throw new WorkerSupervisorError('invalid_summary', 'summary response is invalid');
  if (!Array.isArray(payload.provenanceIds) || payload.provenanceIds.length > MAX_PROVENANCE_IDS || payload.provenanceIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128)) throw new WorkerSupervisorError('invalid_summary', 'summary response is invalid');
  return { summary: payload.summary, provenanceIds: payload.provenanceIds as string[] };
}

export class WorkerSupervisor {
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly maxInFlight: number;
  private readonly spawnWorker: (executable: string, args: readonly string[]) => ChildProcess;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private child: ChildProcess | undefined;
  private decoder = new WorkerFrameDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly completed = new Set<string>();
  private readonly canceled = new Set<string>();
  private stderrBytes = 0;
  private shuttingDown = false;

  constructor(options: WorkerSupervisorOptions) {
    if (!options.executable || options.executable.includes('\0')) throw new WorkerSupervisorError('invalid_executable', 'worker executable is invalid');
    this.executable = options.executable;
    this.args = [...options.args];
    this.defaultTimeoutMs = boundedPositiveInteger(options.defaultTimeoutMs, 10_000);
    this.maxInFlight = Math.min(boundedPositiveInteger(options.maxInFlight, MAX_IN_FLIGHT), MAX_IN_FLIGHT);
    this.spawnWorker = options.spawn ?? ((executable, args) => nodeSpawn(executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  get stderrDiagnostic(): string {
    return this.stderrBytes === 0 ? '' : `[worker stderr redacted: ${this.stderrBytes} bytes]`;
  }

  get responseIdTrackingSize(): number {
    return this.completed.size + this.canceled.size;
  }

  private trackRecentId(ids: Set<string>, id: string): void {
    ids.add(id);
    if (ids.size > MAX_TRACKED_RESPONSE_IDS) ids.delete(ids.values().next().value as string);
  }

  private ensureChild(): ChildProcess {
    if (this.child && !this.child.killed) return this.child;
    if (this.shuttingDown) throw new WorkerSupervisorError('shutting_down', 'worker is shutting down');
    const child = this.spawnWorker(this.executable, this.args);
    this.child = child;
    this.decoder = new WorkerFrameDecoder();
    child.stdout?.on('data', chunk => this.receive(chunk));
    child.stderr?.on('data', chunk => this.receiveStderr(chunk));
    child.on('error', error => this.failChild(new WorkerSupervisorError('worker_error', error.message)));
    child.on('exit', () => this.failChild(new WorkerSupervisorError('worker_crash', 'worker exited')));
    return child;
  }

  private receive(chunk: Uint8Array): void {
    try {
      for (const response of this.decoder.push(chunk)) this.receiveResponse(validateWorkerResponse(response));
    } catch (error) {
      this.failChild(error instanceof Error ? error : new WorkerSupervisorError('protocol_error', 'worker protocol failed'));
    }
  }

  private receiveResponse(response: WorkerResponse): void {
    if (this.completed.has(response.id)) {
      this.failChild(new WorkerSupervisorError('duplicate_response_id', 'worker response ID was duplicated'));
      return;
    }
    if (this.canceled.has(response.id)) {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.failChild(new WorkerSupervisorError('unknown_response_id', 'worker response ID was unknown'));
      return;
    }
    this.pending.delete(response.id);
    this.trackRecentId(this.completed, response.id);
    this.clearTimer(pending.timer);
    if (!response.ok) {
      pending.reject(new WorkerSupervisorError(response.error?.code ?? 'worker_error', 'worker request failed'));
      return;
    }
    try {
      this.validateOperationResponse(pending.operation, response.payload);
      pending.resolve(response);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new WorkerSupervisorError('invalid_response', 'worker response was invalid'));
    }
  }

  private validateOperationResponse(operation: WorkerOperation, payload: unknown): void {
    if (!isRecord(payload)) throw new WorkerSupervisorError('invalid_response', 'worker response payload is invalid');
    if (operation === 'summarize') {
      responseKeys(payload, ['summary', 'provenanceIds']);
      validateSummary(payload);
    }
    if (operation === 'embed_query') {
      responseKeys(payload, ['embedding']);
      validateEmbedding(payload.embedding);
    }
    if (operation === 'embed_documents') {
      responseKeys(payload, ['embeddings']);
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length === 0) throw new WorkerSupervisorError('invalid_embedding', 'embedding response is invalid');
      payload.embeddings.forEach(embedding => validateEmbedding(embedding));
    }
    if (operation === 'health') {
      responseKeys(payload, ['status']);
      if (payload.status !== 'ok') throw new WorkerSupervisorError('invalid_response', 'health response is invalid');
    }
    if (operation === 'unload') responseKeys(payload, []);
  }

  private receiveStderr(chunk: Uint8Array): void {
    this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + chunk.byteLength);
  }

  private failChild(error: Error): void {
    if (!this.child && this.pending.size === 0) return;
    const child = this.child;
    this.child = undefined;
    for (const [id, pending] of this.pending) {
      this.clearTimer(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (child && !child.killed) child.kill();
  }

  private request(operation: WorkerOperation, payload: Record<string, unknown>, timeoutMs = this.defaultTimeoutMs): Promise<WorkerResponse> {
    validateTimeout(timeoutMs);
    if (this.pending.size >= this.maxInFlight) return Promise.reject(new WorkerSupervisorError('in_flight_limit', 'worker in-flight limit reached'));
    const id = randomUUID();
    let request: ReturnType<typeof validateWorkerRequest>;
    try {
      request = validateWorkerRequest({ id, version: 1, operation, payload });
    } catch (error) {
      if (error instanceof WorkerProtocolError) throw new WorkerSupervisorError(error.code, 'worker request is invalid');
      throw new WorkerSupervisorError('invalid_request', 'worker request is invalid');
    }
    const child = this.ensureChild();
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (!this.pending.delete(id)) return;
        this.trackRecentId(this.canceled, id);
        this.sendCancel(id);
        reject(new WorkerSupervisorError('timeout', 'worker request timed out'));
      }, timeoutMs);
      this.pending.set(id, { operation, resolve, reject, timer });
      try {
        child.stdin?.write(encodeWorkerFrame(request));
      } catch {
        this.pending.delete(id);
        this.clearTimer(timer);
        reject(new WorkerSupervisorError('worker_write', 'worker request could not be sent'));
      }
    });
  }

  private sendCancel(requestId: string): void {
    if (!this.child || this.child.killed) return;
    try {
      const request = validateWorkerRequest({ id: randomUUID(), version: 1, operation: 'cancel', payload: { requestId } });
      this.child.stdin?.write(encodeWorkerFrame(request));
    } catch {
      this.failChild(new WorkerSupervisorError('worker_write', 'worker cancellation could not be sent'));
    }
  }

  async summarize(text: string, provenanceIds: string[], timeoutMs?: number): Promise<{ summary: string; provenanceIds: string[] }> {
    const response = await this.request('summarize', { text, provenanceIds }, timeoutMs);
    return validateSummary(response.payload);
  }

  async embedDocuments(texts: string[], timeoutMs?: number): Promise<number[][]> {
    const response = await this.request('embed_documents', { texts }, timeoutMs);
    if (!isRecord(response.payload) || !Array.isArray(response.payload.embeddings)) throw new WorkerSupervisorError('invalid_embedding', 'embedding response is invalid');
    return response.payload.embeddings.map(embedding => validateEmbedding(embedding));
  }

  async embedQuery(text: string, timeoutMs?: number): Promise<number[]> {
    const response = await this.request('embed_query', { text }, timeoutMs);
    if (!isRecord(response.payload)) throw new WorkerSupervisorError('invalid_embedding', 'embedding response is invalid');
    return validateEmbedding(response.payload.embedding);
  }

  async health(timeoutMs?: number): Promise<WorkerResponse> {
    return this.request('health', {}, timeoutMs);
  }

  async unload(timeoutMs?: number): Promise<void> {
    validateTimeout(timeoutMs ?? this.defaultTimeoutMs);
    if (!this.child) return;
    await this.request('unload', {}, timeoutMs);
    this.closeChild();
  }

  async shutdown(timeoutMs = this.defaultTimeoutMs): Promise<void> {
    validateTimeout(timeoutMs);
    this.shuttingDown = true;
    try {
      if (this.child) await this.unload(timeoutMs);
    } finally {
      this.closeChild();
      this.failChild(new WorkerSupervisorError('shutdown', 'worker shut down'));
    }
  }

  private closeChild(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin?.end();
    if (!child.killed) child.kill();
  }
}

export { MAX_IN_FLIGHT, EMBEDDING_DIMENSIONS, MAX_WORKER_FRAME_BYTES };