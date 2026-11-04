import { expect, it } from 'vitest';
import { prepareRoutingPrompt } from '../src/model-routing.js';

function promptInput(originalTask: string) {
  return {
    role: 'specialist' as const,
    category: 'implementation',
    stableInstructions: ['Keep the accepted constraints in scope.'],
    originalTask,
    requiredConstraints: ['Preserve the existing provider identity.'],
    tools: [{ name: 'read', description: 'Read project files.' }],
    jobState: 'The first review found one unresolved issue.',
    providerIdentityRequirements: ['Keep the provider supplied by the host.'],
    evidence: [{ source: 'tool-result', content: 'The existing implementation owns this route.' }],
  };
}

it('preserves task requirements, tool results, job state, and provenance in the prompt result', () => {
  const result = prepareRoutingPrompt(promptInput('Update the accepted implementation task.'));

  expect(result).toEqual({
    prefix: {
      role: 'specialist',
      category: 'implementation',
      stableInstructions: ['Keep the accepted constraints in scope.'],
      tools: [{ name: 'read', description: 'Read project files.' }],
      providerIdentityRequirements: ['Keep the provider supplied by the host.'],
    },
    task: {
      originalTask: 'Update the accepted implementation task.',
      requiredConstraints: ['Preserve the existing provider identity.'],
      evidence: [{ source: 'tool-result', content: 'The existing implementation owns this route.' }],
      jobState: 'The first review found one unresolved issue.',
    },
  });
});

it('keeps the specialist prefix stable when the current task changes', () => {
  const first = prepareRoutingPrompt(promptInput('Inspect the routing behavior.'));
  const second = prepareRoutingPrompt(promptInput('Apply the accepted routing fix.'));

  expect(second.prefix).toEqual(first.prefix);
  expect(second.task.originalTask).not.toBe(first.task.originalTask);
});
