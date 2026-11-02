import { AsyncLocalStorage } from 'node:async_hooks';
import { wrapLanguageModel } from 'ai';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Middleware } from '@ai-sdk/provider';

const contentsKey = Symbol('anthropic tool result content');
const managedTransportKey = Symbol('managed anthropic cache transport');
type Contents = { tools: Map<string, unknown[]>; blocks: Map<string, unknown> };
const emptyContents = (): Contents => ({ tools: new Map(), blocks: new Map() });
type ScopedOptions = LanguageModelV4CallOptions & { [contentsKey]?: Contents };

export function assertAnthropicCacheTransport(model: unknown, messages: readonly unknown[]): void {
  const marked = messages.some(message => {
    if (!message || typeof message !== 'object' || !('role' in message) || (message.role !== 'tool' && message.role !== 'user')
      || !('content' in message) || !Array.isArray(message.content)) return false;
    return message.content.some((part: unknown) => {
      if (!part || typeof part !== 'object' || !('providerOptions' in part)) return false;
      const options = part.providerOptions as { leverframe?: { nativeToolResultContent?: unknown; nativeUserBlock?: unknown } } | undefined;
      return Array.isArray(options?.leverframe?.nativeToolResultContent) || options?.leverframe?.nativeUserBlock !== undefined;
    });
  });
  if (marked && (!model || typeof model !== 'object' || !(managedTransportKey in model))) {
    throw new TypeError('Anthropic native content requires the managed transport');
  }
}

function stripTags(params: LanguageModelV4CallOptions): ScopedOptions {
  const contents = emptyContents();
  const prompt = params.prompt.map(message => {
    if (message.role === 'user') return { ...message, content: message.content.map(part => {
      if (part.type !== 'text') return part;
      const metadata = part.providerOptions?.leverframe;
      if (!metadata || metadata.nativeUserBlock === undefined) return part;
      if (contents.blocks.has(part.text)) throw new TypeError('Ambiguous Anthropic content');
      contents.blocks.set(part.text, metadata.nativeUserBlock);
      const { leverframe: _private, ...providerOptions } = part.providerOptions!;
      return { ...part, providerOptions };
    }) };
    if (message.role !== 'tool') return message;
    return { ...message, content: message.content.map(part => {
      if (part.type !== 'tool-result') return part;
      const metadata = part.providerOptions?.leverframe;
      if (!metadata || !Array.isArray(metadata.nativeToolResultContent)) return part;
      if (contents.tools.has(part.toolCallId)) throw new TypeError('Ambiguous Anthropic tool result');
      contents.tools.set(part.toolCallId, metadata.nativeToolResultContent);
      const { leverframe: _private, ...providerOptions } = part.providerOptions!;
      return { ...part, providerOptions };
    }) };
  });
  return { ...params, prompt, [contentsKey]: contents };
}

function applyContents(body: unknown, contents: Contents): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid Anthropic request');
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) throw new TypeError('Invalid Anthropic request');
  const found = new Set<string>();
  const foundBlocks = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (let index = 0; index < content.length; index++) {
      const block = content[index];
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string' && contents.blocks.has(record.text)) {
        if (foundBlocks.has(record.text)) throw new TypeError('Ambiguous Anthropic content');
        foundBlocks.add(record.text);
        content[index] = contents.blocks.get(record.text);
        continue;
      }
      const id = record.tool_use_id;
      if (record.type !== 'tool_result' || typeof id !== 'string' || !contents.tools.has(id)) continue;
      if (found.has(id)) throw new TypeError('Ambiguous Anthropic tool result');
      record.content = contents.tools.get(id);
      found.add(id);
    }
  }
  if (found.size !== contents.tools.size || foundBlocks.size !== contents.blocks.size) throw new TypeError('Anthropic content not found');
}

export function createAnthropicCacheTransport(baseFetch: typeof fetch) {
  const context = new AsyncLocalStorage<Contents>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const contents = context.getStore();
    if (!contents || (!contents.tools.size && !contents.blocks.size)) return baseFetch(input, init);
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (request.method !== 'POST') throw new TypeError('Invalid Anthropic request method');
    const body: unknown = await request.clone().json();
    applyContents(body, contents);
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    return baseFetch(new Request(request, { method: 'POST', headers, body: JSON.stringify(body) }));
  };
  const middleware: LanguageModelV4Middleware = {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => stripTags(params),
    wrapGenerate: async ({ params, doGenerate }) => context.run((params as ScopedOptions)[contentsKey] ?? emptyContents(), doGenerate),
    wrapStream: async ({ params, doStream }) => context.run((params as ScopedOptions)[contentsKey] ?? emptyContents(), doStream),
  };
  return { fetch, wrap: (model: LanguageModelV4) => {
    const wrapped = wrapLanguageModel({ model, middleware });
    Object.defineProperty(wrapped, managedTransportKey, { value: true });
    return wrapped;
  } };
}
