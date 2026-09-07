
import type { Agent as HttpAgent } from 'node:http';
import type { WebSocket as WsWebSocket } from 'ws';

export type JsonObject = Record<string, unknown>;

export interface ResponsesWebSocketFetchOptions {
  providerId?: string;
  accountId?: string;

  hardTtlMs?: number;
  idleTtlMs?: number;
  nurseryIdleTtlMs?: number;
  maxConnections?: number;
  maxNurseryConnections?: number;
  maxTransportRetries?: 0 | 1;
  handshakeTimeoutMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  random?: () => number;
  eagerResponseForTests?: boolean;
  now?: () => number;

  onDiagnostic?: (event: ResponsesWebSocketDiagnosticEvent) => void;
}

export interface ResponsesWebSocketDiagnosticEvent extends Record<string, unknown> {
  event: string;
  requestId?: string;
}

export interface ResponsesWebSocketDiagnosticContext {
  requestId?: string;
  claudeSessionId?: string;
}

export interface OutputAccumulator {
  type?: string;
  itemId?: string;
  text: string;
  summaries: Map<number, string>;
  done?: JsonObject;
}

export type ReasoningPartState = 'active' | 'can_conclude' | 'concluded';

export interface RequestContext {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  originalPayload: JsonObject;
  sendPayload: JsonObject;
  promptFieldHashes: Record<string, string>;
  instructionsSnapshot?: string;
  continued: boolean;
  retried: boolean;
  closed: boolean;
  frameCount: number;
  responseId?: string;
  pendingEvents: unknown[];
  emittedModelData: boolean;
  transportRetryCount: number;
  transportRetryPending: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  provider: string;
  model?: string;
  handshakeSettled: boolean;
  resolveHandshake?: () => void;
  rejectHandshake?: (reason: unknown) => void;
  outputByIndex: Map<number, OutputAccumulator>;
  outputIndexByItemId: Map<string, number>;
  reasoningPartsByItemId: Map<string, Map<number, ReasoningPartState>>;
  recentUpstreamEventTypes: string[];
  emittedProtocolAnomalies: Set<string>;
  emitDiagnostic?: (event: { event: string } & Record<string, unknown>) => void;
  entry?: ConnectionEntry;
  createReplacement: () => ConnectionEntry;

  redispatch: (entry: ConnectionEntry) => void;
  abortCleanup?: () => void;

  requestId?: string;
}

export interface ConnectionEntry {
  debugId: number;
  key?: string;
  credentialScopeKey?: string;
  credentialFingerprint?: string;
  socket: WsWebSocket;
  persistent: boolean;
  generation: 'nursery' | 'established' | 'isolated';
  open: boolean;
  createdAt: number;
  ttlPausedMs: number;
  inFlightStartedAt?: number;
  lastUsedAt: number;
  inFlight: boolean;
  upgradeResponsePending: boolean;
  current?: RequestContext;
  promptFieldHashes?: Record<string, string>;
  instructionsSnapshot?: string;
  responseId?: string;
  requestInput?: unknown[];
  expectedAssistant?: unknown[];

  lastRequestId?: string;
  options: Required<Pick<
    ResponsesWebSocketFetchOptions,
    'hardTtlMs' | 'idleTtlMs' | 'nurseryIdleTtlMs' | 'maxConnections'
    | 'maxTransportRetries' | 'handshakeTimeoutMs' | 'retryBaseDelayMs' | 'retryMaxDelayMs'
    | 'random' | 'now'
  >> & { awaitOpen: boolean };
  debug: (message: string) => void;
}

export type ContinuationMatchMode = 'exact' | 'omitted_reasoning';

export interface ContinuationMatch {
  delta: unknown[];
  mode: ContinuationMatchMode;
}

export type WebSocketConstructor = new (
  url: string,
  options: {
    headers: Record<string, string>;
    agent?: HttpAgent;
    handshakeTimeout: number;
  },
) => WsWebSocket;
