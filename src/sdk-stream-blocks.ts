import type { AnthropicUsage } from './sdk-usage.js';
import type { StreamTools } from './sdk-stream-tools.js';

export class StreamBlocks {
  private readonly messageId = 'msg_' + Date.now();
  index = -1;
  started = false;
  openType: 'text' | 'thinking' | null = null;
  thinkingSignature: string | undefined;

  constructor(private modelId: string, private emit: (event: string, data: unknown) => void) {}

  start(): void {
    if (this.started) return;
    this.emit('message_start', {
      type: 'message_start', message: {
        id: this.messageId, type: 'message', role: 'assistant', content: [],
        model: this.modelId, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    this.started = true;
  }

  close(): void {
    if (this.openType === 'thinking') {
      this.emit('content_block_delta', {
        type: 'content_block_delta', index: this.index,
        delta: { type: 'signature_delta', signature: this.thinkingSignature ?? '' },
      });
      this.thinkingSignature = undefined;
    }
    if (this.openType) this.emit('content_block_stop', { type: 'content_block_stop', index: this.index });
    this.openType = null;
  }

  open(type: 'text' | 'thinking' | 'tool', contentBlock: unknown): void {
    this.start();
    this.close();
    this.index++;
    this.openType = type === 'tool' ? null : type;
    this.emit('content_block_start', { type: 'content_block_start', index: this.index, content_block: contentBlock });
  }

  closeAll(tools: StreamTools): void {
    this.close();
    for (const id of tools.indices.keys()) tools.close(id);
  }

  truncate(tools: StreamTools, usage: AnthropicUsage, signal?: AbortSignal): boolean {
    if (!this.started || !signal || signal.aborted) return false;
    this.closeAll(tools);
    this.emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage });
    this.emit('message_stop', { type: 'message_stop' });
    return true;
  }
}
