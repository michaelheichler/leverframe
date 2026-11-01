import { encodeToolUseId, grabRoundTripSignature, parseToolArguments, type FullStreamPart } from './proxy-shared.js';
import { anthropicErrorType, upstreamHttpStatus } from './upstream-error.js';
import { ProviderTransportError } from './provider-error.js';
import { sanitizeToolInput, type toolInputRules } from './sdk-request-translation.js';
import { finishStreamUsage } from './sdk-stream-finish.js';
import type { AnthropicUsage } from './sdk-usage.js';
import type { AnthropicStreamObserver } from './sdk-streaming-response.js';
import type { StreamBlocks } from './sdk-stream-blocks.js';
import type { StreamTools } from './sdk-stream-tools.js';

export class StreamEvents {
  finishReason = 'end_turn';
  sdkFinishReason: string | undefined;
  rawFinishReason: string | undefined;
  outputContentBytes = 0;
  usage: AnthropicUsage;

  constructor(private options: {
    modelId: string; blocks: StreamBlocks; tools: StreamTools; rules: ReturnType<typeof toolInputRules>;
    emit: (event: string, data: unknown) => void; maxToolBytes: () => number;
    observer?: AnthropicStreamObserver; log?: (message: () => string) => void;
  }) {
    this.usage = { input_tokens: options.observer?.initialInputTokens ?? 0, output_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  }

  output(bytes: number): void { this.outputContentBytes += bytes; }

  handle(part: FullStreamPart): void {
    if (['reasoning-start', 'reasoning-delta', 'reasoning-end', 'text-start', 'text-delta', 'text-end'].includes(part.type)) return this.content(part);
    if (['tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call'].includes(part.type)) return this.tool(part);
    if (part.type === 'finish') return this.finish(part);
    if (part.type === 'error') return this.error(part);
    if (part.type !== 'start') this.options.log?.(() => `sdk stream unrecognized part type=${part.type} keys=${Object.keys(part).join(',')} sample=${safeJson(part)}`);
  }

  private content(part: FullStreamPart): void {
    const { blocks, observer, emit } = this.options;
    if (part.type === 'reasoning-start' || part.type === 'text-start') return blocks.close();
    if (part.type === 'reasoning-end') {
      const signature = grabRoundTripSignature(part);
      if (signature) {
        if (blocks.openType !== 'thinking') blocks.open('thinking', { type: 'thinking', thinking: '', signature: '' });
        blocks.thinkingSignature = signature;
      }
      return;
    }
    if ((part.type !== 'text-delta' && part.type !== 'reasoning-delta') || !part.text) return;
    const thinking = part.type === 'reasoning-delta';
    if (blocks.openType !== (thinking ? 'thinking' : 'text')) {
      blocks.open(thinking ? 'thinking' : 'text', thinking ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' });
    }
    this.output(Buffer.byteLength(part.text, 'utf8'));
    emit('content_block_delta', { type: 'content_block_delta', index: blocks.index,
      delta: thinking ? { type: 'thinking_delta', thinking: part.text } : { type: 'text_delta', text: part.text } });
    if (!thinking) observer?.lifecycle?.markOutputEmitted();
    observer?.onOutputByte?.();
  }

  private tool(part: FullStreamPart): void {
    const { blocks, tools, observer, rules, modelId } = this.options;
    const id = part.type === 'tool-call' ? part.toolCallId ?? '' : part.id ?? '';
    if (part.type === 'tool-call') {
      this.finishReason = 'tool_use';
      observer?.lifecycle?.markToolCallEmitted();
    }
    if (part.type === 'tool-input-start' || (part.type === 'tool-call' && !tools.indices.has(id))) {
      blocks.open('tool', { type: 'tool_use', id: encodeToolUseId(id, grabRoundTripSignature(part)), name: part.toolName, input: {} });
      tools.indices.set(id, blocks.index);
      tools.names.set(id, part.toolName ?? '');
      tools.buffers.set(id, '');
      tools.emittedLengths.set(id, 0);
      if (part.type === 'tool-input-start') {
        tools.openedAt.set(id, Date.now());
        const timer = setInterval(() => tools.flush(id), 2_000);
        timer.unref?.();
        tools.timers.set(id, timer);
        observer?.lifecycle?.markToolCallEmitted();
      }
    }
    if (part.type === 'tool-input-delta') {
      const appended = (tools.buffers.get(id) ?? '') + (part.delta ?? part.text ?? '');
      if (appended.length > this.options.maxToolBytes()) throw new ProviderTransportError({
        provider: 'sdk-adapter', model: modelId, phase: 'stream', category: 'tool_call_protocol', retryable: true,
        outputEmitted: blocks.started, safeMessage: `Tool call ${tools.names.get(id) ?? ''} exceeded the max buffered JSON size (${appended.length} bytes)`,
      });
      tools.buffers.set(id, appended);
    }
    if (part.type === 'tool-call') {
      const json = part.input !== undefined && part.input !== null
        ? JSON.stringify(sanitizeToolInput(parseToolArguments(part.input), rules.get(part.toolName ?? '')))
        : (tools.buffers.get(id) || '{}');
      tools.close(id, json);
    }
  }

  private finish(part: FullStreamPart): void {
    const { observer, modelId } = this.options;
    this.usage = finishStreamUsage({ usage: this.usage, providerUsage: part.totalUsage, outputContentBytes: this.outputContentBytes,
      inputTokensIncludeCache: observer?.inputTokensIncludeCache ?? false, modelId,
      promptCacheKeyHash: observer?.promptCacheKeyHash, onUsage: observer?.onUsage });
    if (part.finishReason === 'length') this.finishReason = 'max_tokens';
    else if (part.finishReason === 'tool-calls') this.finishReason = 'tool_use';
    else if (part.finishReason === 'stop' && this.finishReason !== 'tool_use') this.finishReason = 'end_turn';
    this.sdkFinishReason = part.finishReason;
    this.rawFinishReason = part.rawFinishReason;
  }

  private error(part: FullStreamPart): never {
    const error = part.error as { data?: unknown; message?: string } | undefined;
    const message = error?.message || (typeof part.error === 'string' ? part.error : JSON.stringify(error?.data ?? part.error));
    const errorType = anthropicErrorType(upstreamHttpStatus(part.error, message));
    this.options.log?.(() => `sdk stream error (${errorType}): ${message}`);
    this.options.blocks.closeAll(this.options.tools);
    throw part.error instanceof Error || (part.error && typeof part.error === 'object') ? part.error : new Error(message);
  }
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value)?.slice(0, 500) ?? String(value); } catch { return String(value); }
}
