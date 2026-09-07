import { describe, expect, it } from 'vitest';
import { digestableMessageFrom, toDigestableMessages } from '../src/server/route-helpers.js';

describe('server request fingerprint inputs', () => {
  it('retains role-only messages with an explicit null content value', () => {
    expect(digestableMessageFrom({ role: 'assistant' })).toEqual({
      role: 'assistant',
      content: null,
    });
  });

  it('retains structured top-level system content in the fingerprint sequence', () => {
    const system = [{ type: 'text', text: 'Follow the stated policy.' }];
    expect(toDigestableMessages({ system, messages: [{ role: 'user', content: 'hello' }] })).toEqual([
      { role: 'system', content: system },
      { role: 'user', content: 'hello' },
    ]);
  });
});
