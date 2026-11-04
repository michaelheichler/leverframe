import { relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { getAppHome, getProvidersPath } from '../src/paths.js';
import { buildDesiredPatchConfig, computePatchConfigHash } from '../src/patcher.js';
import type { RoutingConfig } from '../src/model-routing.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const modelRef = { providerId: 'fixture-policy-provider', modelId: 'fixture-policy-model' };
const preflight = {
  target: modelRef,
  policyModelId: 'leverframe:fixture-policy-provider:fixture-policy-model',
  contextWindow: 70_000,
  metadata: { contextWindow: 70_000, maxOutputTokens: 8_000, supportedReasoningEfforts: ['low'] },
  targetMetadata: { 'leverframe:fixture-policy-provider:fixture-policy-model': {
    contextWindow: 70_000, maxOutputTokens: 8_000, supportedReasoningEfforts: ['low'],
  } },
  identity: { upstreamModelId: 'fixture-upstream-model', credentialSource: 'registry' as const,
    transportFingerprint: 'fixture-transport-fingerprint' },
  accountIds: [],
};

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function assertFixturePathsAreIsolated(): void {
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  expect(inside(outerHome!, getProvidersPath())).toBe(true);
}

function policyConfig(): RoutingConfig {
  return {
    enabled: true,
    defaultCategory: 'implementation',
    agentCategories: { reviewer: 'review' },
    categories: {
      implementation: { instructions: 'Keep the accepted implementation constraints.' },
      review: { instructions: 'Check the behavior and explain remaining risks.' },
    },
    cheapFallback: modelRef,
    pool: [modelRef],
  };
}

function desiredConfig(routingConfig: RoutingConfig, routingAvailable = true) {
  return buildDesiredPatchConfig([], undefined, { routingAvailable, routingConfig, routingPreflight: preflight });
}

it('projects the active category policy into patch configuration with its instructions and mappings', () => {
  assertFixturePathsAreIsolated();

  const desired = desiredConfig(policyConfig());
  const policy = desired.config['auto']?.routingPromptPolicy;

  expect(policy).toMatchObject({
    defaultCategory: 'implementation',
    agentCategories: { reviewer: 'review' },
    categoryInstructions: {
      implementation: 'Keep the accepted implementation constraints.',
      review: 'Check the behavior and explain remaining risks.',
    },
  });
  expect(policy?.version).toBeDefined();
});

it.each([
  { label: 'default category', change: (config: RoutingConfig): RoutingConfig => ({ ...config, defaultCategory: 'review' }) },
  { label: 'agent mapping', change: (config: RoutingConfig): RoutingConfig => ({ ...config, agentCategories: { reviewer: 'implementation' } }) },
  { label: 'category instructions', change: (config: RoutingConfig): RoutingConfig => ({ ...config,
    categories: { ...config.categories, implementation: { instructions: 'Retain the reviewed task state.' } } }) },
])('changes the active patch hash when the $label changes and leaves disabled hashing alone', ({ change }) => {
  assertFixturePathsAreIsolated();
  const initial = policyConfig();
  const changed = change(initial);
  const activeInitial = desiredConfig(initial);
  const activeChanged = desiredConfig(changed);
  const disabledInitial = desiredConfig(initial, false);
  const disabledChanged = desiredConfig(changed, false);

  expect(computePatchConfigHash(activeChanged.config)).not.toBe(computePatchConfigHash(activeInitial.config));
  expect(computePatchConfigHash(disabledChanged.config)).toBe(computePatchConfigHash(disabledInitial.config));
});
