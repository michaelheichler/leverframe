import { expect, it } from 'vitest';
import { selectRoutingCategory, type RoutingPromptPolicy } from '../src/model-routing.js';

function routingPolicy(): RoutingPromptPolicy {
  return {
    version: 1,
    defaultCategory: 'general',
    agentCategories: { reviewer: 'review' },
    categoryInstructions: {
      general: 'Use the general constraints.',
      implementation: 'Preserve the accepted implementation constraints.',
      review: 'Review the requested behavior.',
      research: 'Gather source evidence.',
      deep_research: 'Gather broader source evidence.',
      quick_start: 'Begin with a concise project setup.',
    },
  };
}

it.each([
  { label: 'explicit category', input: { explicitCategory: 'review', agentType: 'reviewer', originalTask: 'Implement the requested behavior.' },
    category: 'review', provenance: 'explicit' },
  { label: 'agent mapping', input: { agentType: 'reviewer', originalTask: 'Implement the requested behavior.' },
    category: 'review', provenance: 'agent_mapping' },
  { label: 'unique task match', input: { originalTask: 'Continue the implementation.' },
    category: 'implementation', provenance: 'task_category_match' },
])('selects the highest-priority configured source for a $label', ({ input, category, provenance }) => {
  const result = selectRoutingCategory({ policy: routingPolicy(), verifiedSpecialist: true, ...input });

  expect(result).toEqual({ role: 'specialist', category, provenance });
});

it('keeps unverified work in the router role even when it names a category', () => {
  const result = selectRoutingCategory({ policy: routingPolicy(), verifiedSpecialist: false,
    explicitCategory: 'review', agentType: 'reviewer', originalTask: 'Review the requested behavior.' });

  expect(result).toEqual({ role: 'router', provenance: 'unverified' });
});

it('matches category names when task text uses hyphens for underscores', () => {
  const result = selectRoutingCategory({ policy: routingPolicy(), verifiedSpecialist: true,
    originalTask: 'Follow the quick-start instructions.' });

  expect(result).toEqual({ role: 'specialist', category: 'quick_start', provenance: 'task_category_match' });
});

it('falls back to the configured default when task text matches overlapping categories', () => {
  const result = selectRoutingCategory({ policy: routingPolicy(), verifiedSpecialist: true,
    originalTask: 'Continue deep_research.' });

  expect(result).toEqual({ role: 'specialist', category: 'general', provenance: 'default' });
});

it('rejects a category that is absent from the captured policy', () => {
  expect(() => selectRoutingCategory({ policy: routingPolicy(), verifiedSpecialist: true,
    explicitCategory: 'unconfigured', originalTask: 'Review the requested behavior.' })).toThrow('unconfigured');
});
