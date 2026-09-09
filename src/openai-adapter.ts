import { streamText, generateText, type LanguageModel } from 'ai';
import { openAiFinishReason, formatOpenAiResponse } from './openai-response-format.js';
export { translateOpenAiRequest, type OpenAiMessage, type OpenAiRequest } from './openai-request-translation.js';
import type { SdkCallParams } from './sdk-adapter.js';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { toUpstreamStreamError } from './stream-error.js';

export interface CollectedOpenAiStream {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: string | undefined;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
}

interface SdkStreamPart {
  type: string;
  textDelta?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  finishReason?: string;
  totalUsage?: CollectedOpenAiStream['usage'];
  usage?: CollectedOpenAiStream['usage'];
  error?: unknown;
  id?: string;
  delta?: string;
  argsTextDelta?: string;
}

export async function collectOpenAiStream(
  stream: AsyncIterable<unknown>,
  lifecycle?: RequestExecutionObserver,
): Promise<CollectedOpenAiStream> {
  const collected: CollectedOpenAiStream = { text: '', toolCalls: [], finishReason: undefined, usage: undefined };
  for await (const part of stream) {
    const p = part as SdkStreamPart;
    lifecycle?.abortSignal.throwIfAborted();
    lifecycle?.markStreamActivity();
    switch (p.type) {
      case 'text-delta':
        collected.text += p.textDelta ?? p.text ?? '';
        if (collected.text) lifecycle?.markOutputEmitted();
        break;
      case 'tool-call':
        collected.toolCalls.push({
          toolCallId: p.toolCallId ?? '',
          toolName: p.toolName ?? '',
          input: p.input,
        });
        lifecycle?.markToolCallEmitted();
        break;
      case 'finish':
        collected.finishReason = p.finishReason ?? collected.finishReason;
        collected.usage = p.totalUsage ?? p.usage ?? collected.usage;
        break;
      case 'abort':
        throw new DOMException('Upstream request aborted', 'AbortError');
      case 'error':
        throw toUpstreamStreamError(p.error);
    }
  }
  lifecycle?.abortSignal.throwIfAborted();
  return collected;
}

export interface OpenAiResponseOptions {
  forceStream?: boolean;
  abortSignal?: AbortSignal;
  onWarning?: (message: string) => void;

  lifecycle?: RequestExecutionObserver;
}

export async function generateOpenAiResponse(
  model: LanguageModel,
  params: SdkCallParams,
  responseModelId: string,
  options?: OpenAiResponseOptions,
) {
  const abortSignal = options?.lifecycle?.abortSignal ?? options?.abortSignal;
  options?.lifecycle?.startConnecting();
  let result: { text: string; toolCalls?: CollectedOpenAiStream['toolCalls']; finishReason?: string; usage?: CollectedOpenAiStream['usage'] };
  if (options?.forceStream) {
    const { stream } = streamText({
      model,
      ...params,
      allowSystemInMessages: true,
      abortSignal,
      onError: () => {},
    } as Parameters<typeof streamText>[0]);
    result = await collectOpenAiStream(stream, options?.lifecycle);
  } else {
    result = (await generateText({
      model,
      ...params,
      allowSystemInMessages: true,
      abortSignal,
    } as Parameters<typeof generateText>[0])) as typeof result;
  }
  abortSignal?.throwIfAborted();
  options?.lifecycle?.markHeadersReceived();
  if (!result.usage || [result.usage.inputTokens, result.usage.outputTokens, result.usage.totalTokens].some(value => value === undefined)) {
    options?.onWarning?.(`warning: OpenAI adapter upstream omitted token usage for model ${responseModelId}; defaulting missing values to zero`);
  }
  if (result.text) options?.lifecycle?.markOutputEmitted();
  if (result.toolCalls?.length) options?.lifecycle?.markToolCallEmitted();
  return formatOpenAiResponse(result, responseModelId);
}

export async function streamOpenAiResponse(
  model: LanguageModel,
  params: SdkCallParams,
  responseModelId: string,
  onChunk: (chunk: string) => void,
  options?: { abortSignal?: AbortSignal; lifecycle?: RequestExecutionObserver },
): Promise<void> {
  const abortSignal = options?.lifecycle?.abortSignal ?? options?.abortSignal;
  options?.lifecycle?.startConnecting();
  const { stream } = streamText({
    model,
    ...params,
    allowSystemInMessages: true,
    abortSignal,
    onError: () => {},
  } as Parameters<typeof streamText>[0]);
  const baseData = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: responseModelId,
  };

  const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    onChunk(`data: ${JSON.stringify({ ...baseData, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const sendUsage = (usage: NonNullable<CollectedOpenAiStream['usage']>) => onChunk(`data: ${JSON.stringify({
    ...baseData,
    choices: [],
    usage: {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? 0,
    },
  })}\n\n`);

  const toolIndices = new Map<string, number>();
  let finish: SdkStreamPart | undefined;
  let headersMarked = false;
  for await (const part of stream) {
    abortSignal?.throwIfAborted();
    const p = part as SdkStreamPart;
    if (!headersMarked) {
      headersMarked = true;
      options?.lifecycle?.markHeadersReceived();
    }
    options?.lifecycle?.markStreamActivity();
    switch (p.type) {
      case 'text-delta':
        send({ role: 'assistant', content: p.textDelta ?? p.text ?? '' });
        options?.lifecycle?.markOutputEmitted();
        break;
      case 'tool-call': {
        const id = p.toolCallId ?? '';
        if (toolIndices.has(id)) break;
        const index = toolIndices.size;
        toolIndices.set(id, index);
        send({ role: 'assistant', tool_calls: [{ index, id, type: 'function', function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) } }] });
        options?.lifecycle?.markToolCallEmitted();
        break;
      }
      case 'tool-input-start': {
        const id = p.id ?? p.toolCallId ?? '';
        const index = toolIndices.get(id) ?? toolIndices.size;
        toolIndices.set(id, index);
        send({ role: 'assistant', tool_calls: [{ index, id, type: 'function', function: { name: p.toolName, arguments: '' } }] });
        options?.lifecycle?.markToolCallEmitted();
        break;
      }
      case 'tool-input-delta': {
        const index = toolIndices.get(p.id ?? p.toolCallId ?? '');
        if (index === undefined) throw new Error('Tool input delta without a tool start');
        send({ tool_calls: [{ index, function: { arguments: p.delta ?? p.text ?? p.argsTextDelta ?? '' } }] });
        break;
      }
      case 'finish':
        finish = p;
        break;
      case 'abort':
        throw new DOMException('Upstream request aborted', 'AbortError');
      case 'error':
        throw toUpstreamStreamError(p.error);
    }
  }

  abortSignal?.throwIfAborted();
  if (finish) {
    send({}, openAiFinishReason(finish.finishReason));
    const usage = finish.totalUsage ?? finish.usage;
    if (usage) sendUsage(usage);
  }
  onChunk('data: [DONE]\n\n');
}
