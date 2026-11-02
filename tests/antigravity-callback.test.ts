import { describe, expect, it } from 'vitest';
import { receiveAntigravityCode } from '../src/oauth/antigravity-callback.js';

function callbackRequest(redirectUri: string, state: string, code: string): Promise<Response> {
  const callback = new URL(redirectUri);
  callback.searchParams.set('state', state);
  callback.searchParams.set('code', code);
  return fetch(callback);
}

describe('Antigravity loopback authorization callback', () => {
  it('accepts one code and rejects a concurrent callback replay', async () => {
    const state = 'one-login-state';
    let callbackResponses!: Promise<number[]>;
    const result = await receiveAntigravityCode({
      state, port: 0, timeoutMs: 2_000,
      openAuthorization: redirectUri => {
        callbackResponses = Promise.all([
          callbackRequest(redirectUri, state, 'code-one').then(response => response.status, () => 0),
          callbackRequest(redirectUri, state, 'code-two').then(response => response.status, () => 0),
        ]);
      },
    });
    const statuses = await callbackResponses;

    expect(statuses.sort((left, right) => left - right)).toEqual([0, 200]);
    expect(['code-one', 'code-two']).toContain(result.code);
  });
});
