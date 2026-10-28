import { describe, expect, it } from 'vitest';
import { withoutCacheControlScope } from '../src/anthropic-cache-control.js';

function requestWithCacheControl(cacheControl: unknown) {
  return {
    model: 'claude-cache-fixture',
    scope: 'ordinary request metadata',
    system: [{ type: 'text', text: 'System context', cache_control: cacheControl }],
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'User context', cache_control: cacheControl }],
    }],
    tools: [{
      name: 'fixture_tool',
      input_schema: { type: 'object', properties: { scope: { type: 'string' } } },
      cache_control: cacheControl,
    }],
  };
}

describe('cache-control scope removal', () => {
  it('removes subscription scope from system, message, and tool caches while retaining TTL and unrelated fields', () => {
    const input = requestWithCacheControl({ type: 'ephemeral', scope: 'organization', ttl: '1h' });
    const expected = requestWithCacheControl({ type: 'ephemeral', ttl: '1h' });

    const result = withoutCacheControlScope(input);

    expect(result).toEqual(expected);
  });

  it('leaves the original request and its cache controls unchanged', () => {
    const cacheControl = Object.freeze({ type: 'ephemeral', scope: 'organization', ttl: '1h' });
    const input = requestWithCacheControl(cacheControl);
    const original = structuredClone(input);

    withoutCacheControlScope(input);

    expect(input).toEqual(original);
  });

  it.each(['system', 'messages', 'tools'] as const)('returns independent %s arrays and blocks', section => {
    const input = requestWithCacheControl({ type: 'ephemeral', scope: 'organization', ttl: '1h' });

    const result = withoutCacheControlScope(input);

    expect(result[section]).not.toBe(input[section]);
    expect(result[section][0]).not.toBe(input[section][0]);
  });
});

describe('cache-control traversal compatibility', () => {
  it.each([null, undefined, false, 42, 'provider-default', ['unparsed-cache-value']])(
    'preserves non-record cache_control values (%j)', cacheControl => {
      const input = requestWithCacheControl(cacheControl);

      const result = withoutCacheControlScope(input);

      expect(result).toEqual(input);
    },
  );

  it('traverses nested arrays without changing nulls or primitive values', () => {
    const input = [
      null,
      { cache_control: { type: 'ephemeral', scope: 'organization', ttl: '5m' } },
      [false, 7, 'context', null, { nested: { cache_control: { type: 'ephemeral', scope: 'request' } } }],
    ];

    const result = withoutCacheControlScope(input);

    expect(result).toEqual([
      null,
      { cache_control: { type: 'ephemeral', ttl: '5m' } },
      [false, 7, 'context', null, { nested: { cache_control: { type: 'ephemeral' } } }],
    ]);
  });
});
