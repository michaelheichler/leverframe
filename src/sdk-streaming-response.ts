
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';
import {
  sseChunk,
  type FullStreamPart,
} from './proxy-shared.js';
import { ProviderTransportError } from './provider-error.js';
import { emptyCompletionError } from './sdk-completion.js';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { StreamTools } from './sdk-stream-tools.js';
import { StreamBlocks } from './sdk-stream-blocks.js';
import { StreamEvents } from './sdk-stream-events.js';
import { toolInputRules, type SdkCallParams } from './sdk-request-translation.js';
import {
  type AnthropicUsageTrace,
  sdkPromptCacheKeyHash,
} from './sdk-usage.js';

export type SdkTranslationErrorSignature =
  | 'reasoning_part_not_found'
  | 'text_part_not_found';

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

  onPart?: (partType: string) => void;

  initialInputTokens?: number;
  inputTokensIncludeCache?: boolean;
  onUsage?: (usage: AnthropicUsageTrace) => void;
  promptCacheKeyHash?: string;
  abortSignal?: AbortSignal;

  idleTimeoutMs?: number;

  lifecycle?: RequestExecutionObserver;

  clientAbortSignal?: AbortSignal;
  contextWindow?: number;

  onOutputByte?: () => void;

  outputIdleTimeoutMs?: number;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 500) ?? String(value);
  } catch {
    return String(value);
  }
}

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

function isOutputStallAbort(signal?: AbortSignal): boolean {
  const reason: unknown = signal?.reason;
  return ProviderTransportError.isInstance(reason)
    && (reason as ProviderTransportError).category === 'output_stall_timeout';
}

export function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sdkStreamIdleTimeoutMs(): number {
  return positiveEnvMs('LEVERFRAME_SDK_IDLE_TIMEOUT_MS', 10 * 60_000);
}

function nonStreamRequestTimeoutMs(): number {
  return positiveEnvMs('LEVERFRAME_SDK_REQUEST_TIMEOUT_MS', 60 * 60_000);
}

function toolEarlyFlushByteThreshold(): number {
  return positiveEnvMs('LEVERFRAME_TOOL_EARLY_FLUSH_BYTES', 8_000);
}

function toolEarlyFlushOpenMs(): number {
  return positiveEnvMs('LEVERFRAME_TOOL_EARLY_FLUSH_MS', 5_000);
}

function toolJsonMaxBytes(): number {
  return positiveEnvMs('LEVERFRAME_TOOL_JSON_MAX_BYTES', 2_000_000);
}

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
  const emit = (event: string, data: unknown) => write(sseChunk(event, data));
  const blocks = new StreamBlocks(modelId, emit);
  const inputRules = toolInputRules(tools);
  const seenPartTypes: string[] = [];
  let events: StreamEvents;
  const toolState = new StreamTools({
    rules: inputRules, threshold: toolEarlyFlushByteThreshold, openMs: toolEarlyFlushOpenMs,
    emit, currentIndex: () => blocks.index,
    output: bytes => events.output(bytes),
    afterOutput: () => {
      observer?.lifecycle?.markOutputEmitted();
      observer?.onOutputByte?.();
    },
  });
  events = new StreamEvents({ modelId, blocks, tools: toolState, rules: inputRules, emit, maxToolBytes: toolJsonMaxBytes, observer, log });
  try {
  for await (const part of stream) {
    seenPartTypes.push(part.type);
    observer?.onPart?.(part.type);
    observer?.lifecycle?.markStreamActivity();
    if (observer?.abortSignal?.aborted) {
      if (!isOutputStallAbort(observer.abortSignal) && blocks.truncate(toolState, events.usage, observer?.clientAbortSignal)) return;
      throw streamAbortError(observer.abortSignal);
    }
    if (part.type === 'abort') {
      if (!isOutputStallAbort(observer?.abortSignal) && blocks.truncate(toolState, events.usage, observer?.clientAbortSignal)) return;
      throw streamAbortError(observer?.abortSignal);
    }
    events.handle(part);
  }
  if (observer?.abortSignal?.aborted) {
    if (!isOutputStallAbort(observer.abortSignal) && blocks.truncate(toolState, events.usage, observer?.clientAbortSignal)) return;
    throw streamAbortError(observer.abortSignal);
  }

  if (events.sdkFinishReason === undefined || events.sdkFinishReason === 'error' || !blocks.started) {
    log?.(() => `sdk stream produced no content: seen part types=${seenPartTypes.join(',')} rawFinishReason=${events.rawFinishReason}`);
    throw emptyCompletionError(modelId, events.usage, observer?.contextWindow, events.sdkFinishReason, blocks.started, events.rawFinishReason);
  }

  blocks.closeAll(toolState);
  blocks.start();
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: events.finishReason, stop_sequence: null }, usage: events.usage });
  emit('message_stop', { type: 'message_stop' });
  } finally {
    toolState.clearTimers();
  }
}

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
  streamAbortError,
  forwardAbortSignal,
  sdkStreamIdleTimeoutMs,
  nonStreamRequestTimeoutMs,
};
