import type { toolInputRules } from './sdk-request-translation.js';

export class StreamTools {
  readonly indices = new Map<string, number>();
  readonly names = new Map<string, string>();
  readonly buffers = new Map<string, string>();
  readonly emittedLengths = new Map<string, number>();
  readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  readonly openedAt = new Map<string, number>();
  readonly flushed = new Set<string>();

  constructor(private options: {
    rules: ReturnType<typeof toolInputRules>;
    threshold: () => number;
    openMs: () => number;
    emit: (event: string, data: unknown) => void;
    currentIndex: () => number;
    output: (bytes: number) => void;
    afterOutput: () => void;
  }) {}

  private canFlush(id: string): boolean {
    const rules = this.options.rules.get(this.names.get(id) ?? '');
    if (!rules || (rules.required.size === 0 && Object.keys(rules.properties).length === 0 && rules.omitEmptyArrays.size === 0)) return true;
    if (rules.omitEmptyArrays.size > 0) return false;
    if ((this.buffers.get(id)?.length ?? 0) >= this.options.threshold()) return true;
    const opened = this.openedAt.get(id);
    return opened !== undefined && Date.now() - opened >= this.options.openMs();
  }

  private emitJson(id: string, json: string): void {
    const length = this.emittedLengths.get(id) ?? 0;
    const prefix = this.buffers.get(id)?.slice(0, length) ?? '';
    let output = json;
    if (!output.startsWith(prefix)) {
      const raw = this.buffers.get(id) ?? '';
      if (length === 0 || !raw.startsWith(prefix)) return;
      output = raw;
    }
    const suffix = output.slice(length);
    if (!suffix) return;
    this.options.output(Buffer.byteLength(suffix, 'utf8'));
    this.options.emit('content_block_delta', {
      type: 'content_block_delta', index: this.indices.get(id) ?? this.options.currentIndex(),
      delta: { type: 'input_json_delta', partial_json: suffix },
    });
    this.emittedLengths.set(id, output.length);
    this.options.afterOutput();
  }

  flush(id: string): void {
    if (!this.flushed.has(id) && this.canFlush(id)) this.emitJson(id, this.buffers.get(id) ?? '');
  }

  clearTimers(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  close(id: string, json = this.buffers.get(id) ?? ''): void {
    if (this.flushed.has(id)) return;
    const timer = this.timers.get(id);
    if (timer !== undefined) clearInterval(timer);
    this.timers.delete(id);
    this.emitJson(id, json);
    this.flushed.add(id);
    this.options.emit('content_block_stop', { type: 'content_block_stop', index: this.indices.get(id) });
  }
}
