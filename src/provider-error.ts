export type ProviderFailurePhase =
  | 'connect'
  | 'websocket_upgrade'
  | 'headers'
  | 'stream'
  | 'completion';

const PROVIDER_FAILURE_PHASES = new Set<ProviderFailurePhase>([
  'connect',
  'websocket_upgrade',
  'headers',
  'stream',
  'completion',
]);

/**
 * Provider-neutral error taxonomy (stabilization plan §7.1). Every category a
 * caller can classify a failure into, independent of which SDK/transport
 * produced it. `unknown` is the only category a caller should ever need to
 * fall back to.
 */
export type ProviderErrorCategory =
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'overload'
  | 'invalid_request'
  | 'unsupported_capability'
  | 'context_length'
  | 'connection'
  | 'dns'
  | 'tls'
  | 'proxy'
  | 'connect_timeout'
  | 'header_timeout'
  | 'idle_timeout'
  | 'total_timeout'
  | 'protocol'
  | 'truncated_stream'
  | 'tool_call_protocol'
  | 'tool_result_submission'
  | 'upstream'
  | 'child_process'
  | 'cancellation'
  | 'local_shutdown'
  | 'ambiguous_execution'
  | 'corrupt_checkpoint'
  | 'credential'
  | 'unknown';

const PROVIDER_ERROR_CATEGORIES = new Set<ProviderErrorCategory>([
  'auth',
  'permission',
  'rate_limit',
  'overload',
  'invalid_request',
  'unsupported_capability',
  'context_length',
  'connection',
  'dns',
  'tls',
  'proxy',
  'connect_timeout',
  'header_timeout',
  'idle_timeout',
  'total_timeout',
  'protocol',
  'truncated_stream',
  'tool_call_protocol',
  'tool_result_submission',
  'upstream',
  'child_process',
  'cancellation',
  'local_shutdown',
  'ambiguous_execution',
  'corrupt_checkpoint',
  'credential',
  'unknown',
]);

/** Categories that are never safe to retry automatically, regardless of `retryable`. */
const TERMINAL_CATEGORIES = new Set<ProviderErrorCategory>([
  'invalid_request',
  'unsupported_capability',
  'context_length',
  'permission',
  'protocol',
  'ambiguous_execution',
  'corrupt_checkpoint',
]);

export function isProviderErrorCategory(value: unknown): value is ProviderErrorCategory {
  return typeof value === 'string' && PROVIDER_ERROR_CATEGORIES.has(value as ProviderErrorCategory);
}

/** OS-level connect-failure error codes that map to a connection-establishment category. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
]);
const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_NODATA', 'EAI_NONAME']);
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const PROXY_ERROR_CODES = new Set(['ERR_PROXY_CONNECTION_FAILED', 'ECONNRESET_PROXY']);

interface ClassifyProviderErrorInput {
  phase: ProviderFailurePhase;
  httpStatus?: number;
  cause?: unknown;
  timeoutKind?: 'connect' | 'header' | 'idle' | 'total';
  cancelled?: 'local' | 'provider';
}

function causeCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isTlsCause(cause: unknown): boolean {
  const code = causeCode(cause);
  if (code && TLS_ERROR_CODES.has(code)) return true;
  const message = cause instanceof Error ? cause.message : '';
  return /certificate|tls|ssl handshake/i.test(message);
}

/**
 * Best-effort classifier used when a caller does not already know the exact
 * category. Explicit categories passed to {@link ProviderTransportError}
 * always win over this inference.
 */
export function classifyProviderErrorCategory(input: ClassifyProviderErrorInput): ProviderErrorCategory {
  if (input.cancelled === 'local') return 'local_shutdown';
  if (input.cancelled === 'provider') return 'cancellation';

  if (input.timeoutKind === 'connect') return 'connect_timeout';
  if (input.timeoutKind === 'header') return 'header_timeout';
  if (input.timeoutKind === 'idle') return 'idle_timeout';
  if (input.timeoutKind === 'total') return 'total_timeout';

  const code = causeCode(input.cause);
  if (code && DNS_ERROR_CODES.has(code)) return 'dns';
  if (code && PROXY_ERROR_CODES.has(code)) return 'proxy';
  if (isTlsCause(input.cause)) return 'tls';
  if (code && CONNECTION_ERROR_CODES.has(code)) return 'connection';

  const status = input.httpStatus;
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 503) return 'overload';
  if (status !== undefined && status >= 500) return 'upstream';

  if (input.phase === 'connect') return 'connection';
  if (input.phase === 'websocket_upgrade') return 'protocol';
  if (input.phase === 'stream') return 'truncated_stream';

  return 'unknown';
}

export interface ProviderTransportErrorOptions {
  provider: string;
  model?: string;
  phase: ProviderFailurePhase;
  /** Provider-neutral taxonomy category. Inferred from phase/status/cause when omitted. */
  category?: ProviderErrorCategory;
  httpStatus?: number;
  providerRequestId?: string;
  osErrorCode?: string;
  retryAfterMs?: number;
  retryable: boolean;
  retriesExhausted?: boolean;
  outputEmitted: boolean;
  cause?: unknown;
  safeMessage: string;
  /** Redacted diagnostic detail safe to log but not necessarily safe to show a user. */
  diagnosticDetail?: string;
  responseHeaders?: Readonly<Record<string, string>>;
  attemptCount?: number;
}

export class ProviderTransportError extends Error {
  readonly code = 'provider_transport_error';
  readonly provider: string;
  readonly model?: string;
  readonly phase: ProviderFailurePhase;
  readonly category: ProviderErrorCategory;
  readonly httpStatus?: number;
  readonly providerRequestId?: string;
  readonly osErrorCode?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly retriesExhausted: boolean;
  readonly outputEmitted: boolean;
  readonly safeMessage: string;
  readonly diagnosticDetail?: string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly attemptCount: number;

  constructor(options: ProviderTransportErrorOptions) {
    super(options.safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderTransportError';
    this.provider = options.provider;
    this.model = options.model;
    this.phase = options.phase;
    this.category = options.category ?? classifyProviderErrorCategory({
      phase: options.phase,
      httpStatus: options.httpStatus,
      cause: options.cause,
    });
    this.httpStatus = options.httpStatus;
    this.providerRequestId = options.providerRequestId;
    this.osErrorCode = options.osErrorCode ?? causeCode(options.cause);
    this.retryAfterMs = options.retryAfterMs !== undefined
      && Number.isFinite(options.retryAfterMs)
      && options.retryAfterMs >= 0
      ? options.retryAfterMs
      : undefined;
    // A category that is intrinsically terminal (e.g. invalid_request) can never be retryable,
    // even if a caller mistakenly passes retryable: true.
    this.retryable = options.retryable && !TERMINAL_CATEGORIES.has(this.category);
    this.retriesExhausted = options.retriesExhausted ?? false;
    this.outputEmitted = options.outputEmitted;
    this.safeMessage = options.safeMessage;
    this.diagnosticDetail = options.diagnosticDetail;
    this.responseHeaders = options.responseHeaders
      ? Object.freeze({ ...options.responseHeaders })
      : undefined;
    this.attemptCount = options.attemptCount ?? 1;
  }

  static isInstance(value: unknown): value is ProviderTransportError {
    if (value instanceof ProviderTransportError) return true;
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ProviderTransportError>;
    return candidate.name === 'ProviderTransportError'
      && candidate.code === 'provider_transport_error'
      && typeof candidate.provider === 'string'
      && typeof candidate.phase === 'string'
      && PROVIDER_FAILURE_PHASES.has(candidate.phase as ProviderFailurePhase)
      && typeof candidate.retryable === 'boolean'
      && (candidate.retriesExhausted === undefined || typeof candidate.retriesExhausted === 'boolean')
      && typeof candidate.outputEmitted === 'boolean'
      && typeof candidate.safeMessage === 'string';
  }
}

export function parseRetryAfter(
  value: string | readonly string[] | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1_000) return undefined;
    return seconds * 1_000;
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return undefined;

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - nowMs);
}

const LOCAL_FAILURE_CATEGORIES = new Set<ProviderErrorCategory>([
  'local_shutdown',
  'ambiguous_execution',
  'corrupt_checkpoint',
  'credential',
]);

export interface LocalFailureErrorOptions {
  category: 'local_shutdown' | 'ambiguous_execution' | 'corrupt_checkpoint' | 'credential';
  safeMessage: string;
  cause?: unknown;
  diagnosticDetail?: string;
}

/**
 * Failures with no upstream transport component: local shutdown, ambiguous
 * client-side tool execution, a corrupt on-disk checkpoint, or a local
 * credential problem. Kept distinct from {@link ProviderTransportError},
 * which always carries a provider/phase pair.
 */
export class LocalFailureError extends Error {
  readonly code = 'local_failure_error';
  readonly category: ProviderErrorCategory;
  readonly safeMessage: string;
  readonly diagnosticDetail?: string;

  constructor(options: LocalFailureErrorOptions) {
    super(options.safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LocalFailureError';
    this.category = options.category;
    this.safeMessage = options.safeMessage;
    this.diagnosticDetail = options.diagnosticDetail;
  }

  static isInstance(value: unknown): value is LocalFailureError {
    if (value instanceof LocalFailureError) return true;
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<LocalFailureError>;
    return candidate.name === 'LocalFailureError'
      && candidate.code === 'local_failure_error'
      && typeof candidate.category === 'string'
      && LOCAL_FAILURE_CATEGORIES.has(candidate.category as ProviderErrorCategory)
      && typeof candidate.safeMessage === 'string';
  }
}

export type ToolResultImageErrorCode =
  | 'missing_source'
  | 'unsupported_media_type'
  | 'malformed_base64'
  | 'invalid_url';

const TOOL_RESULT_IMAGE_ERROR_CODES = new Set<ToolResultImageErrorCode>([
  'missing_source',
  'unsupported_media_type',
  'malformed_base64',
  'invalid_url',
]);

export class ToolResultImageError extends Error {
  readonly safeMessage: string;

  constructor(readonly code: ToolResultImageErrorCode) {
    const safeMessage = `Tool-result image content is invalid or unsupported (${code}).`;
    super(safeMessage);
    this.name = 'ToolResultImageError';
    this.safeMessage = safeMessage;
  }

  static isInstance(value: unknown): value is ToolResultImageError {
    if (value instanceof ToolResultImageError) return true;
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ToolResultImageError>;
    return candidate.name === 'ToolResultImageError'
      && typeof candidate.code === 'string'
      && TOOL_RESULT_IMAGE_ERROR_CODES.has(candidate.code as ToolResultImageErrorCode)
      && typeof candidate.safeMessage === 'string';
  }
}
