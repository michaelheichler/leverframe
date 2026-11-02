import { describe, expect, it } from 'vitest';
import { buildAntigravityEnvelope } from '../src/antigravity/envelope.js';

function validInput() {
  return {
    modelId: 'gemini-3.1-pro-high',
    projectId: 'managed-project',
    sessionId: 'session-one',
    request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
  };
}

describe('buildAntigravityEnvelope', () => {
  it('returns a request scoped to the selected model, project, and conversation', () => {
    const result = buildAntigravityEnvelope(validInput());

    expect(result).toMatchObject({
      project: 'managed-project',
      model: 'gemini-3.1-pro-high',
      requestType: 'agent',
      request: {
        sessionId: 'session-one',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });
    expect(result.requestId).toEqual(expect.any(String));
  });

  it.each(['enabledCreditTypes', 'enabled_credit_types'])('rejects a caller credit opt-in named %s', field => {
    const input = validInput();
    const request = { ...input.request, [field]: ['GOOGLE_ONE_AI'] };

    expect(() => buildAntigravityEnvelope({ ...input, request })).toThrow(/credit|billing|unsupported/i);
  });

  it.each(['routingConfig', 'enabledCreditTypes', 'enabled_credit_types'])('rejects subscription controls nested under generationConfig: %s', field => {
    const input = validInput();
    const request = { ...input.request, generationConfig: { [field]: { paidTier: 'paid' } } };

    expect(() => buildAntigravityEnvelope({ ...input, request })).toThrow(/credit|billing|unsupported/i);
  });

  it('keeps credit-like names inside user tool arguments intact', () => {
    const input = validInput();
    const request = {
      contents: [{ role: 'model', parts: [{ functionCall: {
        name: 'inspect', args: { enabledCreditTypes: 'a field in the user payload' },
      } }] }],
    };

    expect(buildAntigravityEnvelope({ ...input, request }).request).toMatchObject(request);
  });

  it.each([
    { modelId: '', projectId: 'project', sessionId: 'session' },
    { modelId: 'model', projectId: ' ', sessionId: 'session' },
    { modelId: 'model', projectId: 'project', sessionId: '\n' },
  ])('rejects incomplete routing identity', overrides => {
    expect(() => buildAntigravityEnvelope({ ...validInput(), ...overrides })).toThrow();
  });
});
