export type RoutingReplayCompatibility = { ok: true } | { ok: false; reason: 'unsupported_transport' | 'unsupported_request' | 'provider_bound_history' };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function cacheControl(value: unknown): boolean {
  return value === undefined || (object(value) && keys(value, ['type', 'ttl']) && value.type === 'ephemeral'
    && (value.ttl === undefined || value.ttl === '5m' || value.ttl === '1h'));
}

function textContent(value: unknown): boolean {
  return typeof value === 'string' || (Array.isArray(value) && value.every(block => object(block)
    && keys(block, ['type', 'text', 'cache_control']) && block.type === 'text' && typeof block.text === 'string'
    && cacheControl(block.cache_control)));
}

function toolsPreserved(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(tool => object(tool)
    && keys(tool, ['name', 'description', 'input_schema', 'cache_control', 'strict'])
    && typeof tool.name === 'string' && tool.name.length > 0
    && (tool.description === undefined || typeof tool.description === 'string') && object(tool.input_schema)
    && (tool.strict === undefined || typeof tool.strict === 'boolean') && cacheControl(tool.cache_control)));
}

function toolChoice(value: unknown): boolean {
  return value === undefined || (object(value) && keys(value, ['type', 'name', 'disable_parallel_tool_use'])
    && ['auto', 'any', 'none', 'tool'].includes(String(value.type))
    && (value.type === 'tool' ? typeof value.name === 'string' && value.name.length > 0 : value.name === undefined)
    && (value.disable_parallel_tool_use === undefined || typeof value.disable_parallel_tool_use === 'boolean'));
}

function nativeToolHistory(messages: unknown[], tools: unknown): boolean {
  const toolNames = new Set(Array.isArray(tools) ? tools.map(tool => object(tool) ? tool.name : undefined) : []);
  const seen = new Set<string>();
  const pending = new Set<string>();
  for (const message of messages) {
    if (!object(message) || !keys(message, ['role', 'content']) || !['user', 'assistant'].includes(String(message.role))) return false;
    if (typeof message.content === 'string') {
      if (pending.size) return false;
      continue;
    }
    if (!Array.isArray(message.content)) return false;
    if (pending.size && message.role !== 'user') return false;
    for (const block of message.content) {
      if (!object(block)) return false;
      if (block.type === 'text' && keys(block, ['type', 'text', 'cache_control'])
        && typeof block.text === 'string' && cacheControl(block.cache_control)
        && !(message.role === 'user' && pending.size > 0)) continue;
      if (block.type === 'tool_use' && message.role === 'assistant'
        && keys(block, ['type', 'id', 'name', 'input', 'cache_control'])
        && typeof block.id === 'string' && block.id.length > 0 && !seen.has(block.id)
        && typeof block.name === 'string' && toolNames.has(block.name) && object(block.input) && cacheControl(block.cache_control)) {
        seen.add(block.id);
        pending.add(block.id);
      } else if (block.type === 'tool_result' && message.role === 'user'
        && keys(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'])
        && typeof block.tool_use_id === 'string' && pending.delete(block.tool_use_id)
        && (block.content === undefined || textContent(block.content))
        && (block.is_error === undefined || typeof block.is_error === 'boolean') && cacheControl(block.cache_control)) {
        continue;
      } else return false;
    }
    if (message.role === 'user' && pending.size) return false;
  }
  return pending.size === 0;
}

export function routingReplayCompatibility(request: unknown, transport: { source: string; target: string }): RoutingReplayCompatibility {
  const supported = ['native-anthropic', 'openai-compatible'];
  if (!transport || !supported.includes(transport.source) || !supported.includes(transport.target)) return { ok: false, reason: 'unsupported_transport' };
  if (!object(request) || !keys(request, ['model', 'messages', 'max_tokens', 'stream', 'system', 'tools', 'tool_choice',
    'metadata', 'output_config', 'thinking', 'temperature', 'top_p', 'top_k', 'stop_sequences'])) {
    return { ok: false, reason: 'unsupported_request' };
  }
  if (typeof request.model !== 'string' || !Number.isSafeInteger(request.max_tokens) || (request.max_tokens as number) <= 0
    || !Array.isArray(request.messages) || (request.system !== undefined && !textContent(request.system))
    || !toolsPreserved(request.tools) || !toolChoice(request.tool_choice)
    || (request.stream !== undefined && typeof request.stream !== 'boolean')
    || (request.stop_sequences !== undefined && (!Array.isArray(request.stop_sequences) || request.stop_sequences.some(item => typeof item !== 'string')))
    || ['temperature', 'top_p', 'top_k'].some(key => request[key] !== undefined
      && (typeof request[key] !== 'number' || !Number.isFinite(request[key])))) {
    return { ok: false, reason: 'unsupported_request' };
  }
  if (request.thinking !== undefined && (!object(request.thinking) || !keys(request.thinking, ['type']) || request.thinking.type !== 'disabled')) {
    return { ok: false, reason: 'provider_bound_history' };
  }
  if (request.output_config !== undefined && (!object(request.output_config) || !keys(request.output_config, ['effort'])
    || (request.output_config.effort !== undefined && typeof request.output_config.effort !== 'string'))) {
    return { ok: false, reason: 'unsupported_request' };
  }
  if (request.metadata !== undefined && (!object(request.metadata) || !keys(request.metadata, ['user_id'])
    || (request.metadata.user_id !== undefined && typeof request.metadata.user_id !== 'string'))) {
    return { ok: false, reason: 'unsupported_request' };
  }
  if (transport.source === 'openai-compatible' || transport.target === 'openai-compatible') {
    if (request.top_p !== undefined || request.top_k !== undefined || request.stop_sequences !== undefined
      || (Array.isArray(request.tools) && request.tools.some(tool => object(tool) && tool.strict !== undefined))
      || (object(request.tool_choice) && request.tool_choice.disable_parallel_tool_use !== undefined)) {
      return { ok: false, reason: 'unsupported_request' };
    }
  }
  const native = transport.source === 'native-anthropic' && transport.target === 'native-anthropic';
  const portable = native ? nativeToolHistory(request.messages, request.tools)
    : request.messages.every(message => object(message) && keys(message, ['role', 'content'])
      && ['user', 'assistant'].includes(String(message.role)) && textContent(message.content));
  if (!portable) {
    return { ok: false, reason: 'provider_bound_history' };
  }
  return { ok: true };
}
