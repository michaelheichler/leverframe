import { expect, it } from 'vitest';
import { formatRequestPolicyOutcome } from '../src/context/request-policy.js';
import { estimateAnthropicInputTokens } from '../src/anthropic-endpoints.js';

it('keeps source content out of policy diagnostics while reporting summary usage separately', () => {
  const privateSource = 'fixture source that must stay out of diagnostics';
  const result = {
    request: { messages: [{ role: 'user', content: privateSource }] },
    outcome: 'reduced' as const,
    reason: 'summary',
    estimatedInputTokens: 120,
    summaryUsage: { inputTokens: 90, outputTokens: 30 },
    summaryChargedMicros: 120,
  };

  const diagnostic = formatRequestPolicyOutcome(result, 5);

  expect(diagnostic).not.toContain(privateSource);
});

it('reports the final request input estimate without changing an unchanged request', () => {
  const request = { model: 'fixture-model', messages: [{ role: 'user', content: 'Keep this request unchanged.' }] };
  const result = { request, outcome: 'unchanged' as const, reason: 'no_reduction' };

  expect(formatRequestPolicyOutcome(result, 2)).toContain(
    `final_input_tokens=${estimateAnthropicInputTokens(request)}`,
  );
});
