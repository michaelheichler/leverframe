import type { ModelMessage } from 'ai';

export type CacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h'; scope?: unknown } | null;

function validMarker(value: unknown): value is CacheControl {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.type === 'ephemeral' && (marker.ttl === undefined || marker.ttl === '5m' || marker.ttl === '1h');
}

function validSlot(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  return !Object.hasOwn(record, 'cache_control') || validMarker(record.cache_control);
}

function protocolChildren(item: Record<string, unknown>): unknown[] {
  if (item.type === 'tool_result' && Array.isArray(item.content)) return item.content.filter(child =>
    child && typeof child === 'object' && ['text', 'image', 'document', 'search_result', 'tool_reference'].includes(String((child as Record<string, unknown>).type)));
  if (item.type === 'search_result' && Array.isArray(item.content)) return item.content.filter(child =>
    child && typeof child === 'object' && (child as Record<string, unknown>).type === 'text');
  const source = item.source;
  if (item.type === 'document' && source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    if (record.type === 'content' && Array.isArray(record.content)) return record.content.filter(child =>
      child && typeof child === 'object' && ['text', 'image'].includes(String((child as Record<string, unknown>).type)));
  }
  return [];
}

function protocolBlocks(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  if (typeof item.type !== 'string' || !['text', 'image', 'document', 'search_result', 'tool_reference', 'tool_result'].includes(item.type)) return [];
  return [item, ...protocolChildren(item).flatMap(child => protocolBlocks(child, depth + 1))];
}

function cleanProtocolBlock(value: unknown, depth = 0): unknown {
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (!protocolBlocks(item, depth).length) return value;
  const marker = item.cache_control;
  const clean = { ...item };
  if (marker != null) {
    if (!validMarker(marker)) throw new TypeError('Invalid Anthropic cache_control');
    clean.cache_control = { type: marker.type, ...(marker.ttl === undefined ? {} : { ttl: marker.ttl }) };
  }
  if ((item.type === 'tool_result' || item.type === 'search_result') && Array.isArray(item.content)) {
    clean.content = item.content.map(child => protocolChildren(item).includes(child) ? cleanProtocolBlock(child, depth + 1) : child);
  }
  if (item.type === 'document' && item.source && typeof item.source === 'object' && !Array.isArray(item.source)) {
    const source = item.source as Record<string, unknown>;
    if (source.type === 'content' && Array.isArray(source.content)) clean.source = { ...source,
      content: source.content.map(child => protocolChildren(item).includes(child) ? cleanProtocolBlock(child, depth + 1) : child) };
  }
  return clean;
}

export function validAnthropicCacheControls(body: unknown): boolean {
  if (!validSlot(body) || !body || typeof body !== 'object' || Array.isArray(body)) return false;
  const request = body as Record<string, unknown>;
  if (Array.isArray(request.system) && !request.system.every(block => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return true;
    const item = block as Record<string, unknown>;
    return item.cache_control == null || (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0);
  })) return false;
  for (const section of [request.system, request.tools]) {
    if (Array.isArray(section) && !section.every(validSlot)) return false;
  }
  if (!Array.isArray(request.messages)) return true;
  for (const message of request.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const role = (message as Record<string, unknown>).role;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!validSlot(block)) return false;
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const item = block as Record<string, unknown>;
      const supported = role === 'user' ? ['text', 'image', 'document', 'search_result', 'tool_result']
        : role === 'assistant' ? ['text', 'tool_use'] : role === 'system' ? ['text'] : [];
      if (item.cache_control != null && (typeof item.type !== 'string' || !supported.includes(item.type))) return false;
      if (!protocolBlocks(item).every(validSlot)) return false;
    }
  }
  return true;
}

export function nativeMarkedToolContent(content: unknown): unknown[] | undefined {
  if (!Array.isArray(content) || !content.some(block => protocolBlocks(block).some(item => item.cache_control != null))) return undefined;
  return content.map(block => cleanProtocolBlock(block));
}

export function nativeUserContent(block: unknown): unknown {
  return cleanProtocolBlock(block);
}

export function anthropicCacheOptions(cacheControl: CacheControl | undefined) {
  if (cacheControl === undefined || cacheControl === null) return undefined;
  if (!validMarker(cacheControl)) throw new TypeError('Invalid Anthropic cache_control');
  return { anthropic: { cacheControl: {
    type: cacheControl.type,
    ...(cacheControl.ttl === undefined ? {} : { ttl: cacheControl.ttl }),
  } } };
}

export function anthropicCacheSettings(npm: string, body: {
  system?: string | Array<string | { text?: string; cache_control?: CacheControl }>;
  cache_control?: CacheControl;
}) {
  const enabled = npm === '@ai-sdk/anthropic';
  const markedSystem = enabled && Array.isArray(body.system)
    && body.system.some(block => typeof block !== 'string' && block.cache_control != null);
  return { enabled, markedSystem, cacheOptions: enabled ? anthropicCacheOptions(body.cache_control) : undefined };
}

export function anthropicSystemMessages(
  system: string | Array<string | { text?: string; cache_control?: CacheControl }> | undefined,
): ModelMessage[] {
  if (!system) return [];
  if (typeof system === 'string') return [{ role: 'system', content: system }];
  return system.flatMap(block => {
    const text = typeof block === 'string' ? block : block.text ?? '';
    const providerOptions = typeof block === 'string' ? undefined : anthropicCacheOptions(block.cache_control);
    return [{ role: 'system', content: text, ...(providerOptions ? { providerOptions } : {}) } as ModelMessage];
  });
}
