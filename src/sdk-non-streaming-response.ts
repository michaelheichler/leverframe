// Non-streaming Anthropic response: collects one SDK generateText/streamText call into a message.
import { streamText, generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { encodeToolUseId, grabRoundTripSignature, type FullStreamPart } from './proxy-shared.js';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { estimateAnthropicInputTokens, estimateAnthropicOutputTokens } from './anthropic-endpoints.js';
import { sanitizeToolInput, toolInputRules, type SdkCallParams } from './sdk-request-translation.js';
import { type AnthropicUsage, type SdkUsage, type AnthropicUsageTrace, toAnthropicUsage, sdkPromptCacheKeyHash } from './sdk-usage.js';
import {
  emptyCompletionError,
  streamAbortError,
  forwardAbortSignal,
  nonStreamRequestTimeoutMs,
  sdkStreamIdleTimeoutMs,
  safeJson,
} from './sdk-streaming-response.js';

type LogFn = (msg: () => string) => void;

export async function generateAnthropicResponse(
  model: LanguageModel,
  params: SdkCallParams,
  modelId: string,
  options?: {
    forceStream?: boolean;
    abortSignal?: AbortSignal;
    onPart?: (partType: string) => void;
    onUsage?: (usage: AnthropicUsageTrace) => void;
    idleTimeoutMs?: number;
    /** See {@link import('./sdk-streaming-response.js').AnthropicStreamObserver.lifecycle}. */
    lifecycle?: RequestExecutionObserver;
    contextWindow?: number;
    log?: LogFn;
  },
): Promise<Record<string, unknown>> {
  let text: string;
  let toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  let finishReason: string;
  let usage: SdkUsage | undefined;
  const seenPartTypes: string[] = [];
  const { inputTokensIncludeCache = false, ...sdkParams } = params;

  if (options?.forceStream) {
    // Some upstreams (e.g. ChatGPT's Codex backend) reject non-streaming requests
    // outright. Request a real stream from the SDK and collect it into one
    // response instead of forwarding the client's non-streaming request upstream.
    const forceAbort = new AbortController();
    const stopForwardingAbort = forwardAbortSignal(options.lifecycle?.abortSignal ?? options.abortSignal, forceAbort);
    const abortSignal = forceAbort.signal;
    const idleTimeoutMs = options.idleTimeoutMs ?? sdkStreamIdleTimeoutMs();
    let idleTimer = setTimeout(
      () => forceAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
      idleTimeoutMs,
    );
    const r = streamText({
      model,
      ...sdkParams,
      abortSignal,
      onError: () => {},
    } as Parameters<typeof streamText>[0]);
    const streamedText: string[] = [];
    const streamedToolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
    let streamedFinishReason = 'stop';
    let streamedUsage: SdkUsage | undefined;
    try {
      for await (const part of r.stream as AsyncIterable<FullStreamPart>) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => forceAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
          idleTimeoutMs,
        );
        seenPartTypes.push(part.type);
        options.onPart?.(part.type);
        options.lifecycle?.markStreamActivity();
        if (abortSignal.aborted || part.type === 'abort') {
          throw streamAbortError(abortSignal);
        }
        if (part.type === 'error') {
          throw part.error instanceof Error || (part.error && typeof part.error === 'object')
            ? part.error
            : new Error(typeof part.error === 'string' ? part.error : 'Upstream stream failed');
        }
        if (part.type === 'text-delta') {
          streamedText.push(part.text ?? '');
          options.lifecycle?.markOutputEmitted();
        } else if (part.type === 'tool-call') {
          streamedToolCalls.push({
            toolCallId: part.toolCallId ?? '',
            toolName: part.toolName ?? '',
            input: part.input,
          });
          options.lifecycle?.markToolCallEmitted();
        } else if (part.type === 'finish') {
          streamedFinishReason = part.finishReason ?? streamedFinishReason;
          streamedUsage = part.totalUsage;
        } else if (part.type !== 'start') {
          options.log?.(() => `sdk generate unrecognized part type=${part.type} keys=${Object.keys(part).join(',')} sample=${safeJson(part)}`);
        }
      }
      if (abortSignal.aborted) throw streamAbortError(abortSignal);
    } finally {
      stopForwardingAbort();
      clearTimeout(idleTimer);
      if (!forceAbort.signal.aborted) forceAbort.abort();
    }
    text = streamedText.join('');
    toolCalls = streamedToolCalls;
    finishReason = streamedFinishReason;
    usage = streamedUsage;
  } else {
    const generateAbort = new AbortController();
    const stopForwardingAbort = forwardAbortSignal(options?.lifecycle?.abortSignal ?? options?.abortSignal, generateAbort);
    const totalTimeoutMs = nonStreamRequestTimeoutMs();
    const totalTimer = setTimeout(
      () => generateAbort.abort(new Error(`provider request exceeded ${Math.round(totalTimeoutMs / 1000)}s`)),
      totalTimeoutMs,
    );
    try {
      options?.lifecycle?.startConnecting();
      const r = await generateText({
        model,
        ...sdkParams,
        abortSignal: generateAbort.signal,
      } as Parameters<typeof generateText>[0]);
      options?.lifecycle?.markHeadersReceived();
      if (r.text) options?.lifecycle?.markOutputEmitted();
      if (r.toolCalls?.length) options?.lifecycle?.markToolCallEmitted();
      ({ text, toolCalls, finishReason, usage } = r);
    } finally {
      stopForwardingAbort();
      clearTimeout(totalTimer);
      if (!generateAbort.signal.aborted) generateAbort.abort();
    }
  }

  if (!text && toolCalls.length === 0 && finishReason !== 'tool-calls' && !usage?.outputTokens) {
    options?.log?.(() => `sdk generate produced no content: seen part types=${seenPartTypes.join(',')} rawFinishReason=${finishReason}`);
    throw emptyCompletionError(modelId, usage?.inputTokens ?? 0, options?.contextWindow, finishReason);
  }

  const inputRules = toolInputRules(params.tools);
  const finalUsage = toAnthropicUsage(usage, inputTokensIncludeCache);
  const hasContent = !!text || toolCalls.length > 0;
  const resolvedUsage: AnthropicUsage = {
    ...finalUsage,
    input_tokens: hasContent && usage?.inputTokens === undefined
      ? estimateAnthropicInputTokens(params as unknown as object)
      : finalUsage.input_tokens,
    output_tokens: hasContent && usage?.outputTokens === undefined
      ? estimateAnthropicOutputTokens(Buffer.byteLength(
        text + toolCalls.map(tc => JSON.stringify(tc.input ?? null)).join(''), 'utf8',
      ))
      : finalUsage.output_tokens,
  };
  const promptCacheKeyHash = sdkPromptCacheKeyHash(params);
  options?.onUsage?.({
    model: modelId,
    ...resolvedUsage,
    ...(promptCacheKeyHash ? { promptCacheKeyHash } : {}),
  });
  return {
    id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model: modelId,
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolCalls.map(tc => ({
        type: 'tool_use',
        id: encodeToolUseId(tc.toolCallId, grabRoundTripSignature(tc as FullStreamPart)),
        name: tc.toolName,
        input: sanitizeToolInput(tc.input as Record<string, unknown> ?? {}, inputRules.get(tc.toolName)),
      })),
    ],
    stop_reason: finishReason === 'tool-calls' ? 'tool_use' : 'end_turn',
    usage: resolvedUsage,
  };
}
