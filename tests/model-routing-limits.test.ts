import { expect, it } from 'vitest';
import { ROUTING_HANDOFF_LIMIT, ROUTING_PROMPT_POLICY_LIMIT } from '../src/constants.js';
import { prepareRoutingHandoff, projectRoutingPromptPolicy, type RoutingPromptPolicy } from '../src/model-routing.js';

function policy(): RoutingPromptPolicy {
  return {
    version: 1,
    defaultCategory: 'review',
    agentCategories: { reviewer: 'review' },
    categoryInstructions: { review: 'Review the requested behavior.' },
  };
}

function handoffInput() {
  return {
    policy: policy(),
    agentType: 'reviewer',
    explicitCategory: 'review',
    delegatedTask: 'Review this bounded task.',
    originalTask: 'Preserve the accepted response behavior.',
    requiredConstraints: ['Keep response order unchanged.'],
    toolInstructions: ['Read the source before making changes.'],
    evidence: [{ source: 'tool-result', content: 'The fixture records current behavior.' }],
    jobState: 'No unresolved subtask remains.',
  };
}

function oversizedEvidence() {
  const content = '🌍\\"'.repeat(6_000);
  const evidence: Array<{ source: string; content: string }> = [];
  while (Buffer.byteLength(JSON.stringify(evidence), 'utf8') <= ROUTING_HANDOFF_LIMIT) {
    evidence.push({ source: 'tool-result', content });
  }
  return evidence;
}

it('rejects a projected prompt policy that exceeds the exported policy limit', () => {
  const instructions = '🌍\\"'.repeat(Math.ceil(ROUTING_PROMPT_POLICY_LIMIT / 4));

  expect(() => projectRoutingPromptPolicy({ enabled: true, categories: { review: { instructions } } })).toThrow();
});

it('rejects a handoff whose individually bounded evidence exceeds the exported envelope limit', () => {
  const input = { ...handoffInput(), evidence: oversizedEvidence() };

  expect(() => prepareRoutingHandoff(input)).toThrow();
});
