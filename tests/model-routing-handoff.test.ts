import { expect, it } from 'vitest';
import { prepareRoutingHandoff, validateReviewedRoutingHandoff, type RoutingPromptPolicy } from '../src/model-routing.js';

function routingPolicy(): RoutingPromptPolicy {
  return {
    version: 1,
    defaultCategory: 'implementation',
    agentCategories: { reviewer: 'review' },
    categoryInstructions: {
      implementation: 'Preserve implementation constraints.',
      review: 'Check the requested behavior and its edge cases.',
    },
  };
}

function handoffInput() {
  return {
    policy: routingPolicy(),
    agentType: 'reviewer',
    explicitCategory: 'review',
    delegatedTask: 'Inspect the changed parser behavior.',
    originalTask: 'Keep the existing parser output stable while changing routing.',
    requiredConstraints: ['Keep response order unchanged.', 'Preserve the native provider identity.'],
    toolInstructions: ['Read the parser implementation.', 'Do not edit generated files.'],
    evidence: [
      { source: 'human-task', content: 'The response order must remain stable.' },
      { source: 'tool-result', content: 'The parser currently keeps source order.' },
    ],
    jobState: 'The first review found one unresolved compatibility case.',
  };
}

function preparedHandoff() {
  return prepareRoutingHandoff(handoffInput());
}

it('preserves task content, constraints, attributed evidence, tool instructions, and category provenance', () => {
  const input = handoffInput();

  const result = prepareRoutingHandoff(input);

  expect(result.provenance).toBe('explicit');
  expect(result.envelope).toMatchObject({
    agentType: input.agentType,
    prefix: {
      role: 'specialist',
      category: input.explicitCategory,
      tools: input.toolInstructions,
    },
    task: {
      delegatedTask: input.delegatedTask,
      originalTask: input.originalTask,
      requiredConstraints: input.requiredConstraints,
      evidence: input.evidence,
      jobState: input.jobState,
    },
    additionalInstructions: [],
  });
  expect(result.envelope.prefix.stableInstructions).toContain(input.policy.categoryInstructions.review);
  expect(result.envelope.prefix.stableInstructions).not.toContain(input.evidence[1]?.content);
});

it('accepts semantically identical handoffs when object keys are reordered', () => {
  const original = preparedHandoff().envelope;
  const reviewed = JSON.stringify({
    additionalInstructions: original.additionalInstructions,
    task: original.task,
    prefix: original.prefix,
    agentType: original.agentType,
    version: original.version,
  });

  expect(validateReviewedRoutingHandoff(original, reviewed)).toBe(reviewed);
});

it('retains the reviewed handoff string when the hook adds bounded extra instructions', () => {
  const original = preparedHandoff().envelope;
  const reviewed = JSON.stringify({ ...original, additionalInstructions: ['Keep the existing response order.'] });

  expect(validateReviewedRoutingHandoff(original, reviewed)).toBe(reviewed);
});

it.each([
  { label: 'delegated task', change: (input: ReturnType<typeof handoffInput>) => ({ ...input, delegatedTask: '' }) },
  { label: 'original task', change: (input: ReturnType<typeof handoffInput>) => ({ ...input, originalTask: undefined as unknown as string }) },
  { label: 'tool instructions', change: (input: ReturnType<typeof handoffInput>) => ({ ...input, toolInstructions: 'read' as unknown as string[] }) },
  { label: 'evidence provenance', change: (input: ReturnType<typeof handoffInput>) => ({ ...input,
    evidence: [{ source: '', content: 'The evidence has no source.' }] }) },
  { label: 'job state', change: (input: ReturnType<typeof handoffInput>) => ({ ...input, jobState: undefined as unknown as string }) },
])('rejects malformed $label input before preparing the handoff', ({ change }) => {
  const baseline = preparedHandoff();
  const malformed = change(handoffInput());

  expect(baseline.envelope.task).toBeDefined();
  expect(() => prepareRoutingHandoff(malformed)).toThrow();
});

it.each([
  { label: 'delegated task', change: (envelope: ReturnType<typeof preparedHandoff>['envelope']) => ({
    ...envelope, task: { ...envelope.task, delegatedTask: 'Replace the accepted task.' },
  }) },
  { label: 'original task', change: (envelope: ReturnType<typeof preparedHandoff>['envelope']) => ({
    ...envelope, task: { ...envelope.task, originalTask: 'Discard the accepted task.' },
  }) },
  { label: 'required constraints', change: (envelope: ReturnType<typeof preparedHandoff>['envelope']) => ({
    ...envelope, task: { ...envelope.task, requiredConstraints: [] },
  }) },
  { label: 'evidence provenance', change: (envelope: ReturnType<typeof preparedHandoff>['envelope']) => ({
    ...envelope, task: { ...envelope.task, evidence: [{ source: 'unattributed', content: 'Changed evidence.' }] },
  }) },
  { label: 'job state', change: (envelope: ReturnType<typeof preparedHandoff>['envelope']) => ({
    ...envelope, task: { ...envelope.task, jobState: 'Discard the current job state.' },
  }) },
  { label: 'category prefix', change: (envelope: ReturnType<typeof preparedHandoff>['envelope']) => ({
    ...envelope, prefix: { ...envelope.prefix, category: 'implementation' },
  }) },
  { label: 'tool instructions', change: (envelope: ReturnType<typeof preparedHandoff>['envelope']) => ({
    ...envelope, prefix: { ...envelope.prefix, tools: [] },
  }) },
])('rejects hook changes to the required $label', ({ change }) => {
  const original = preparedHandoff().envelope;
  const reviewed = JSON.stringify(change(original));

  expect(() => validateReviewedRoutingHandoff(original, reviewed)).toThrow();
});

it('rejects a review that omits current job state', () => {
  const original = preparedHandoff().envelope;
  const { jobState: _jobState, ...task } = original.task;
  const reviewed = JSON.stringify({ ...original, task });

  expect(() => validateReviewedRoutingHandoff(original, reviewed)).toThrow();
});

it('rejects an unknown handoff field', () => {
  const original = preparedHandoff().envelope;
  const reviewed = JSON.stringify({ ...original, unrelated: 'extra parent history' });

  expect(() => validateReviewedRoutingHandoff(original, reviewed)).toThrow();
});

it('rejects a handoff whose serialized payload is oversized', () => {
  const original = preparedHandoff().envelope;
  const reviewed = JSON.stringify(original) + ' '.repeat(2 ** 20);

  expect(() => validateReviewedRoutingHandoff(original, reviewed)).toThrow();
});
