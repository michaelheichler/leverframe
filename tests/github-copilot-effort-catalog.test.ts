import { describe, expect, it } from 'vitest';
import { parseCopilotModelInfo } from '../src/copilot/model-metadata.js';

function model(reasoningEffort: unknown) {
  return {
    id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash',
    supported_endpoints: ['/chat/completions'],
    capabilities: { type: 'chat', supports: { reasoning_effort: reasoningEffort } },
  };
}

describe('Copilot catalog effort capability', () => {
  it('discovers reported effort arrays without guessing routes or token limits', () => {
    expect(parseCopilotModelInfo(model(['low', 'medium', 'high']))).toMatchObject({
      id: 'gemini-3.8-flash', reasoning: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      supportedParameters: ['reasoning_effort'],
      npm: '@ai-sdk/openai-compatible', contextWindowUnconfirmed: true,
    });
  });

  it('preserves explicit top-level efforts and legacy boolean capabilities', () => {
    expect(parseCopilotModelInfo({ ...model(['low', 'medium']), supported_reasoning_efforts: ['high'] }))
      .toMatchObject({ supportedReasoningEfforts: ['high'] });
    expect(parseCopilotModelInfo(model(true))).toMatchObject({ reasoning: true });
    expect(parseCopilotModelInfo(model(false))).toMatchObject({ reasoning: false });
  });

  it('rejects malformed entries and omits unsupported effort labels', () => {
    expect(() => parseCopilotModelInfo(model(['low', 1]))).toThrow('must be a string');
    expect(() => parseCopilotModelInfo(model({ high: true }))).toThrow('must be a boolean');
    expect(parseCopilotModelInfo(model(['future']))).toMatchObject({ reasoning: false, supportedReasoningEfforts: [] });
  });
});
