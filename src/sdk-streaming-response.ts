// SDK fullStream → Anthropic SSE: streaming response emission and block tracking.
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';
import {
  sseChunk,
  encodeToolUseId,
  type FullStreamPart,
  grabRoundTripSignature,
} from './proxy-shared.js';
import { anthropicErrorType, upstreamHttpStatus } from './upstream-error.js';
import { ProviderTransportError } from './provider-error.js';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { estimateAnthropicOutputTokens } from './anthropic-endpoints.js';
import { sanitizeToolInput, toolInputRules, type SdkCallParams } from './sdk-request-translation.js';
import {
  type AnthropicUsage,
  type AnthropicUsageTrace,
  toAnthropicUsage,
  sdkPromptCacheKeyHash,
} from './sdk-usage.js';

export type SdkTranslationErrorSignature =
  | 'reasoning_part_not_found'
  | 'text_part_not_found';
/** Classify privacy-safe AI SDK stream-state errors without logging dynamic part ids. */
export function sdkTranslationErrorSignature(error: unknown): SdkTranslationErrorSignature | undefined {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : undefined;
  if (!message) return undefined;
  if (/\breasoning part \S+ not found\b/i.test(message)) return 'reasoning_part_not_found';
  if (/\btext part \S+ not found\b/i.test(message)) return 'text_part_not_found';
  return undefined;
}

type WriteFn = (chunk: string) => void;

type LogFn = (msg: () => string) => void;

export interface AnthropicStreamObserver {
  /** Called for every AI SDK fullStream part before Relay translates it. */
  onPart?: (partType: string) => void;
  /** Local fallback used when the provider omits usage at stream completion. */
  initialInputTokens?: number;
  inputTokensIncludeCache?: boolean;
  onUsage?: (usage: AnthropicUsageTrace) => void;
  promptCacheKeyHash?: string;
  abortSignal?: AbortSignal;
  /** Abort if the provider produces no stream event for this long. */
  idleTimeoutMs?: number;
  /**
   * Request execution context/observer: driven for phase (stream
   * activity/first-output/tool-call) transitions on every SDK part. Its
   * `abortSignal` (already composed from the caller's cancellation signal
   * plus the connect/header/idle/total deadline classes) takes priority
   * over `abortSignal` above when present. Terminal transitions
   * (`complete`/`fail`) stay owned by the caller, not this module.
   */
  lifecycle?: RequestExecutionObserver;
  /** @why Deadline aborts must remain distinct from downstream disconnects. */
  clientAbortSignal?: AbortSignal;
  contextWindow?: number;
  /**
   * Fired for every client-visible byte written downstream (text-delta,
   * reasoning-delta, non-empty tool-JSON flush). Drives the output-idle
   * watchdog in {@link streamAnthropicResponse}, which is reset only by
   * output, unlike `idleTimeoutMs`, which resets on any SDK part.
   */
  onOutputByte?: () => void;
  /** Overrides `LEVERFRAME_OUTPUT_IDLE_TIMEOUT_MS`, mirroring `idleTimeoutMs`. */
  outputIdleTimeoutMs?: number;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 500) ?? String(value);
  } catch {
    return String(value);
  }
}

function emptyCompletionError(
  modelId: string,
  inputTokens: number,
  contextWindow?: number,
  rawFinishReason?: string,
): ProviderTransportError {
  const overLimit = contextWindow !== undefined && inputTokens > contextWindow;
  const safeMessage = overLimit
    ? `prompt is too long for model ${modelId} (${inputTokens} > ${contextWindow} context)`
    : `Upstream returned no content for model ${modelId} (input_tokens=${inputTokens}, finishReason=${rawFinishReason ?? 'unknown'})`;
  return new ProviderTransportError({
    provider: 'openai-oauth',
    model: modelId,
    phase: 'completion',
    category: overLimit ? 'context_length' : 'upstream',
    httpStatus: 400,
    retryable: false,
    outputEmitted: false,
    safeMessage,
  });
}

/** @why A runaway tool-input-delta stream is a protocol violation, not a content problem. */
function toolJsonRunawayError(options: {
  modelId: string;
  toolName: string;
  bufferedBytes: number;
  outputEmitted: boolean;
}): ProviderTransportError {
  return new ProviderTransportError({
    provider: 'sdk-adapter',
    model: options.modelId,
    phase: 'stream',
    category: 'tool_call_protocol',
    retryable: true,
    outputEmitted: options.outputEmitted,
    safeMessage: `Tool call ${options.toolName} exceeded the max buffered JSON size `
      + `(${options.bufferedBytes} bytes)`,
  });
}

/** @why An output-idle abort must carry a distinct, retryable category from the SDK-part idle timeout. */
function outputStallTimeoutError(options: {
  modelId: string;
  timeoutMs: number;
  outputEmitted: boolean;
}): ProviderTransportError {
  return new ProviderTransportError({
    provider: 'sdk-adapter',
    model: options.modelId,
    phase: 'stream',
    category: 'output_stall_timeout',
    retryable: true,
    outputEmitted: options.outputEmitted,
    safeMessage: `Provider produced no client-visible output for `
      + `${Math.round(options.timeoutMs / 1000)}s despite stream activity`,
  });
}

/** @why Output-stall aborts must reject immediately, not degrade into a truncated completion. */
function isOutputStallAbort(signal?: AbortSignal): boolean {
  const reason: unknown = signal?.reason;
  return ProviderTransportError.isInstance(reason)
    && (reason as ProviderTransportError).category === 'output_stall_timeout';
}

/** @why Malformed durations must retain the configured fallback. */
export function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
/** @why Idle detection must remain bounded without imposing a wall-clock cap. */
function sdkStreamIdleTimeoutMs(): number {
  return positiveEnvMs('LEVERFRAME_SDK_IDLE_TIMEOUT_MS', 10 * 60_000);
}

/** @why Non-stream requests need a backstop while streams rely on idle activity. */
function nonStreamRequestTimeoutMs(): number {
  return positiveEnvMs('LEVERFRAME_SDK_REQUEST_TIMEOUT_MS', 60 * 60_000);
}
/** @why Tool JSON that never reaches the progressive-flush byte threshold still needs a size trigger. */
function toolEarlyFlushByteThreshold(): number {
  return positiveEnvMs('LEVERFRAME_TOOL_EARLY_FLUSH_BYTES', 8_000);
}
/** @why A tool call open this long should flush even under the byte threshold. */
function toolEarlyFlushOpenMs(): number {
  return positiveEnvMs('LEVERFRAME_TOOL_EARLY_FLUSH_MS', 5_000);
}
/** @why Bounds a runaway tool-input-delta stream independent of the flush thresholds above. */
function toolJsonMaxBytes(): number {
  return positiveEnvMs('LEVERFRAME_TOOL_JSON_MAX_BYTES', 2_000_000);
}
/** @why Distinguishes "no client-visible output" from the SDK-part idle timeout above. */
function outputIdleTimeoutMs(): number {
  return positiveEnvMs('LEVERFRAME_OUTPUT_IDLE_TIMEOUT_MS', 45_000);
}

function streamAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal?.reason === 'string' ? signal.reason : 'SDK stream aborted',
  );
  error.name = 'AbortError';
  return error;
}
/**
 * Forward caller cancellation into a Relay-owned controller without creating
 * an AbortSignal.any() composite. Node 24 retains source-aborted composite
 * signals in its internal gcPersistentSignals set when listeners remain.
 */
function forwardAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const forward = () => {
    if (!target.signal.aborted) target.abort(source.reason);
  };
  if (source.aborted) {
    forward();
    return () => {};
  }
  source.addEventListener('abort', forward, { once: true });
  return () => source.removeEventListener('abort', forward);
}

export async function writeAnthropicStream(
  stream: AsyncIterable<FullStreamPart>,
  modelId: string,
  write: WriteFn,
  log?: LogFn,
  observer?: AnthropicStreamObserver,
  tools?: SdkCallParams['tools'],
): Promise<void> {
  const messageId = 'msg_' + Date.now();
  const inputRules = toolInputRules(tools);
  let blockIndex = -1;
  let started = false;
  let openType: 'text' | 'thinking' | 'tool' | null = null;
  let pendingThinkingSig: string | undefined;
  const idToBlock = new Map<string, number>();
  const toolNameById = new Map<string, string>();
  const toolJsonBuffer = new Map<string, string>();
  const emittedToolLengths = new Map<string, number>();
  const toolFlushTimers = new Map<string, ReturnType<typeof setInterval>>();
  const toolOpenedAt = new Map<string, number>();
  const flushedTools = new Set<string>();
  let openToolId: string | null = null;
  let finishReason = 'end_turn';
  let rawFinishReason: string | undefined;
  const seenPartTypes: string[] = [];
  let usage: AnthropicUsage = {
    input_tokens: observer?.initialInputTokens ?? 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  /** @why Fallback source when the provider's finish part omits outputTokens. */
  let outputContentBytes = 0;

  const emit = (event: string, data: unknown) => write(sseChunk(event, data));
  /** @why Early deltas are safe only when sanitization cannot rewrite the payload. */
  const toolCanFlushEarly = (id: string): boolean => {
    const rules = inputRules.get(toolNameById.get(id) ?? '');
    return rules === undefined
      || (rules.required.size === 0
        && Object.keys(rules.properties).length === 0
        && rules.omitEmptyArrays.size === 0);
  };
  /** @why omitEmptyArrays tools (e.g. WebSearch) must stay fully buffered: an unsanitized array is an upstream 400. */
  const toolExemptFromEarlyFlushOverride = (id: string): boolean => {
    const rules = inputRules.get(toolNameById.get(id) ?? '');
    return rules !== undefined && rules.omitEmptyArrays.size > 0;
  };
  /** @why A tool that can't safely flush early may still need to, once it has buffered enough or been open long enough. */
  const toolShouldEarlyFlush = (id: string): boolean => {
    if (toolCanFlushEarly(id)) return true;
    if (toolExemptFromEarlyFlushOverride(id)) return false;
    const buffered = toolJsonBuffer.get(id)?.length ?? 0;
    if (buffered >= toolEarlyFlushByteThreshold()) return true;
    const openedAt = toolOpenedAt.get(id);
    return openedAt !== undefined && Date.now() - openedAt >= toolEarlyFlushOpenMs();
  };
  /** @why Each tool must stop scheduling work once its block closes. */
  const clearToolTimer = (id: string): void => {
    const timer = toolFlushTimers.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      toolFlushTimers.delete(id);
    }
  };
  /** @why Early timers must not survive stream completion or failure. */
  const clearToolTimers = (): void => {
    for (const id of toolFlushTimers.keys()) clearToolTimer(id);
  };
  /** @why Cumulative provider fragments require suffix-only downstream deltas. */
  const emitToolJson = (id: string, json: string): void => {
    const emittedLength = emittedToolLengths.get(id) ?? 0;
    const emittedPrefix = toolJsonBuffer.get(id)?.slice(0, emittedLength) ?? '';
    let output = json;
    if (!output.startsWith(emittedPrefix)) {
      const raw = toolJsonBuffer.get(id) ?? '';
      if (emittedLength === 0 || !raw.startsWith(emittedPrefix)) return;
      output = raw;
    }
    const suffix = output.slice(emittedLength);
    if (!suffix) return;
    outputContentBytes += Buffer.byteLength(suffix, 'utf8');
    emit('content_block_delta', {
      type: 'content_block_delta', index: idToBlock.get(id) ?? blockIndex,
      delta: { type: 'input_json_delta', partial_json: suffix },
    });
    emittedToolLengths.set(id, output.length);
    observer?.lifecycle?.markOutputEmitted();
    observer?.onOutputByte?.();
  };
  /** @why Timers flush once early-flush is safe (identity-safe tool, or over the size/time override). */
  const flushToolJson = (id: string): void => {
    if (flushedTools.has(id) || !toolShouldEarlyFlush(id)) return;
    emitToolJson(id, toolJsonBuffer.get(id) ?? '');
  };
  const ensureStart = () => {
    if (started) return;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', content: [],
        model: modelId, stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    started = true;
  };
  const closeOpen = () => {
    if (openType === 'thinking') {
      emit('content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'signature_delta', signature: pendingThinkingSig ?? '' },
      });
      pendingThinkingSig = undefined;
    }
    if (openType === 'tool' && openToolId !== null && !flushedTools.has(openToolId)) {
      clearToolTimer(openToolId);
      emitToolJson(openToolId, toolJsonBuffer.get(openToolId) ?? '');
      flushedTools.add(openToolId);
    }
    if (openType) emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openType = null;
    openToolId = null;
  };
  const openBlock = (type: 'text' | 'thinking' | 'tool', contentBlock: unknown) => {
    ensureStart(); closeOpen(); blockIndex++; openType = type;
    emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: contentBlock });
  };
  /** @why Truncation is useful only while a downstream consumer remains attached. */
  const clientStillListening = () =>
    started && observer?.clientAbortSignal !== undefined && !observer.clientAbortSignal.aborted;
  /** @why Preserving buffered output avoids billing work that the client never receives. */
  const deliverTruncated = (): boolean => {
    if (!clientStillListening()) return false;
    closeOpen();
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens', stop_sequence: null },
      usage,
    });
    emit('message_stop', { type: 'message_stop' });
    return true;
  };

  try {
  for await (const part of stream) {
    seenPartTypes.push(part.type);
    observer?.onPart?.(part.type);
    observer?.lifecycle?.markStreamActivity();
    if (observer?.abortSignal?.aborted) {
      if (!isOutputStallAbort(observer.abortSignal) && deliverTruncated()) return;
      throw streamAbortError(observer.abortSignal);
    }
    switch (part.type) {
      case 'start': break;
      case 'abort':
        if (!isOutputStallAbort(observer?.abortSignal) && deliverTruncated()) return;
        throw streamAbortError(observer?.abortSignal);

      case 'reasoning-start':
        openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
        break;
      case 'reasoning-delta':
        if (openType !== 'thinking') openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
        outputContentBytes += Buffer.byteLength(part.text ?? '', 'utf8');
        emit('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'thinking_delta', thinking: part.text ?? '' },
        });
        observer?.onOutputByte?.();
        break;
      case 'reasoning-end': {
        const sig = grabRoundTripSignature(part);
        if (sig) pendingThinkingSig = sig;
        break;
      }

      case 'text-start':
        openBlock('text', { type: 'text', text: '' });
        break;
      case 'text-delta':
        if (openType !== 'text') openBlock('text', { type: 'text', text: '' });
        outputContentBytes += Buffer.byteLength(part.text ?? '', 'utf8');
        emit('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'text_delta', text: part.text ?? '' },
        });
        observer?.lifecycle?.markOutputEmitted();
        observer?.onOutputByte?.();
        break;
      case 'text-end': break;

      case 'tool-input-start': {
        const sig = grabRoundTripSignature(part);
        openBlock('tool', {
          type: 'tool_use', id: encodeToolUseId(part.id ?? '', sig), name: part.toolName, input: {},
        });
        const id = part.id ?? '';
        idToBlock.set(id, blockIndex);
        toolNameById.set(id, part.toolName ?? '');
        toolJsonBuffer.set(id, '');
        emittedToolLengths.set(id, 0);
        openToolId = id;
        toolOpenedAt.set(id, Date.now());
        const timer = setInterval(() => flushToolJson(id), 2_000);
        timer.unref?.();
        toolFlushTimers.set(id, timer);
        observer?.lifecycle?.markToolCallEmitted();
        break;
      }
      case 'tool-input-delta': {
        const id = part.id ?? '';
        const appended = (toolJsonBuffer.get(id) ?? '') + (part.delta ?? part.text ?? '');
        if (appended.length > toolJsonMaxBytes()) {
          throw toolJsonRunawayError({
            modelId, toolName: toolNameById.get(id) ?? '', bufferedBytes: appended.length, outputEmitted: started,
          });
        }
        toolJsonBuffer.set(id, appended);
        break;
      }
      case 'tool-input-end': break;

      case 'tool-call': {
        finishReason = 'tool_use';
        observer?.lifecycle?.markToolCallEmitted();
        const id = part.toolCallId ?? '';
        if (idToBlock.has(id)) {
          if (!flushedTools.has(id)) {
            clearToolTimer(id);
            const json = part.input !== undefined && part.input !== null
              ? JSON.stringify(sanitizeToolInput(part.input as Record<string, unknown>, inputRules.get(part.toolName ?? '')))
              : (toolJsonBuffer.get(id) ?? '');
            emitToolJson(id, json);
            flushedTools.add(id);
          }
        } else if (openType !== 'tool') {
          // Non-streamed tool call (no input-start/delta arrived): emit a full block.
          const sig = grabRoundTripSignature(part);
          openBlock('tool', {
            type: 'tool_use', id: encodeToolUseId(id, sig), name: part.toolName, input: {},
          });
          idToBlock.set(id, blockIndex);
          toolNameById.set(id, part.toolName ?? '');
          toolJsonBuffer.set(id, '');
          emittedToolLengths.set(id, 0);
          emitToolJson(
            id,
            JSON.stringify(sanitizeToolInput(part.input as Record<string, unknown> ?? {}, inputRules.get(part.toolName ?? ''))),
          );
          flushedTools.add(id);
        }
        break;
      }

      case 'finish': {
        const outputEstimate = estimateAnthropicOutputTokens(outputContentBytes);
        if (part.totalUsage) {
          const finalUsage = toAnthropicUsage(
            part.totalUsage,
            observer?.inputTokensIncludeCache ?? false,
          );
          const hasFinalInputUsage = finalUsage.input_tokens
            + finalUsage.cache_creation_input_tokens
            + finalUsage.cache_read_input_tokens > 0;
          const outputTokens = part.totalUsage.outputTokens === undefined && outputEstimate > 0
            ? outputEstimate
            : finalUsage.output_tokens;
          usage = hasFinalInputUsage
            ? { ...finalUsage, output_tokens: outputTokens }
            : { ...usage, output_tokens: outputTokens };
        } else if (outputEstimate > 0) {
          usage = { ...usage, output_tokens: outputEstimate };
        }
        observer?.onUsage?.({
          model: modelId,
          ...usage,
          ...(observer.promptCacheKeyHash ? { promptCacheKeyHash: observer.promptCacheKeyHash } : {}),
        });
        if (part.finishReason === 'tool-calls') finishReason = 'tool_use';
        else if (part.finishReason === 'stop' && finishReason !== 'tool_use') finishReason = 'end_turn';
        rawFinishReason = part.finishReason;
        break;
      }

      case 'error': {
        const e = part.error as { data?: unknown; message?: string } | undefined;
        const errMsg = e?.message || (typeof part.error === 'string' ? part.error : JSON.stringify(e?.data ?? part.error));
        const errorType = anthropicErrorType(upstreamHttpStatus(part.error, errMsg));
        log?.(() => `sdk stream error (${errorType}): ${errMsg}`);
        if (deliverTruncated()) return;
        closeOpen();
        throw part.error instanceof Error || (part.error && typeof part.error === 'object')
          ? part.error
          : new Error(errMsg);
      }

      default:
        log?.(() => `sdk stream unrecognized part type=${part.type} keys=${Object.keys(part).join(',')} sample=${safeJson(part)}`);
        break;
    }
  }
  if (observer?.abortSignal?.aborted) {
    if (!isOutputStallAbort(observer.abortSignal) && deliverTruncated()) return;
    throw streamAbortError(observer.abortSignal);
  }

  if (!started && blockIndex === -1 && finishReason === 'end_turn' && usage.output_tokens === 0) {
    log?.(() => `sdk stream produced no content: seen part types=${seenPartTypes.join(',')} rawFinishReason=${rawFinishReason}`);
    throw emptyCompletionError(modelId, usage.input_tokens, observer?.contextWindow, rawFinishReason);
  }

  closeOpen();
  ensureStart();
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: null }, usage });
  emit('message_stop', { type: 'message_stop' });
  } finally {
    clearToolTimers();
  }
}
// ── high-level entry points ──────────────────────────────────────────────────
export async function streamAnthropicResponse(
  model: LanguageModel,
  params: SdkCallParams,
  modelId: string,
  write: WriteFn,
  log?: LogFn,
  observer?: AnthropicStreamObserver,
): Promise<void> {
  const { inputTokensIncludeCache = false, ...sdkParams } = params;
  const idleTimeoutMs = observer?.idleTimeoutMs ?? sdkStreamIdleTimeoutMs();
  const idleAbort = new AbortController();
  const externalAbort = observer?.lifecycle?.abortSignal ?? observer?.abortSignal; // lifecycle composes deadlines
  const stopForwardingAbort = forwardAbortSignal(externalAbort, idleAbort);
  const abortSignal = idleAbort.signal;
  let idleTimer = setTimeout(
    () => idleAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
    idleTimeoutMs,
  );
  const outputIdleMs = observer?.outputIdleTimeoutMs ?? outputIdleTimeoutMs();
  let outputEmittedOnce = false;
  const abortOutputStall = () => idleAbort.abort(outputStallTimeoutError({
    modelId, timeoutMs: outputIdleMs, outputEmitted: outputEmittedOnce,
  }));
  let outputIdleTimer = setTimeout(abortOutputStall, outputIdleMs);
  const resetOutputIdleTimer = () => {
    outputEmittedOnce = true;
    clearTimeout(outputIdleTimer);
    outputIdleTimer = setTimeout(abortOutputStall, outputIdleMs);
  };
  const result = streamText({
    model,
    ...sdkParams,
    abortSignal,
    onError: () => {},
  } as Parameters<typeof streamText>[0]);

  const watchedStream = (async function* () {
    try {
      for await (const part of result.stream as AsyncIterable<FullStreamPart>) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => idleAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
          idleTimeoutMs,
        );
        yield part;
      }
    } finally {
      clearTimeout(idleTimer);
    }
  })();

  try {
    await writeAnthropicStream(watchedStream, modelId, write, log, {
      ...observer,
      abortSignal,
      clientAbortSignal: observer?.clientAbortSignal,
      inputTokensIncludeCache,
      promptCacheKeyHash: sdkPromptCacheKeyHash(params) ?? observer?.promptCacheKeyHash,
      onOutputByte: () => {
        resetOutputIdleTimer();
        observer?.onOutputByte?.();
      },
    }, params.tools);
  } finally {
    stopForwardingAbort();
    clearTimeout(idleTimer);
    clearTimeout(outputIdleTimer);
    if (!idleAbort.signal.aborted) idleAbort.abort();
  }
}

export {
  safeJson,
  emptyCompletionError,
  streamAbortError,
  forwardAbortSignal,
  sdkStreamIdleTimeoutMs,
  nonStreamRequestTimeoutMs,
};
