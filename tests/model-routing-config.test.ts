import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseRoutingConfig } from '../src/routing-config.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { loadPreferences, savePreferences } from '../src/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetLegacyMigrationForTests } from '../src/paths.js';

let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-routing-test-'));
  previousHome = process.env['HOME'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  delete process.env['LEVERFRAME_HOME'];
  resetLegacyMigrationForTests();
});

const modelRef = (providerId: string, modelId: string) => ({ providerId, modelId });

const routingConfiguration = {
  enabled: false,
  visibleModelId: 'workflow-choice',
  visibleModelLabel: 'Workflow choice',
  policy: 'execution',
  pool: [modelRef('provider-a', 'model-a'), modelRef('provider-b', 'model-b')],
  cheapFloor: modelRef('provider-a', 'model-a'),
  cheapFallback: modelRef('provider-b', 'model-b'),
  routerFallbacks: [modelRef('provider-c', 'model-c')],
  defaultCategory: 'coordination',
  categories: {
    coordination: {
      target: modelRef('provider-d', 'model-d'),
      effort: 'custom-coordination-effort',
      instructions: 'Keep the task plan available to the specialist.',
      servingAlternatives: [modelRef('provider-e', 'model-d')],
      fallbacks: [{ ...modelRef('provider-f', 'model-f'), effort: 'custom-fallback-effort' }],
    },
    implementation: {
      target: modelRef('provider-g', 'model-g'),
      effort: 'custom-implementation-effort',
    },
    exploration: {
      target: modelRef('provider-h', 'model-h'),
      effort: 'custom-exploration-effort',
    },
    deep_research: {
      alternatingTargets: [
        { ...modelRef('provider-i', 'model-i'), effort: 'custom-arm-a-effort' },
        { ...modelRef('provider-j', 'model-j'), effort: 'custom-arm-b-effort' },
      ],
    },
  },
  agentCategories: { 'analysis-agent': 'exploration' },
  subscriptionPreference: 'balanced',
  selector: {
    enabled: true,
    target: modelRef('provider-a', 'model-a'),
    fallbacks: [modelRef('provider-k', 'model-k')],
    maxExtraCallsPerTask: 2,
    timeoutMs: 2300,
    maxOutputTokens: 96,
    evaluationEvidence: [
      {
        category: 'exploration',
        effort: 'custom-exploration-effort',
        candidateSetVersion: 'candidate-set-a',
        signatureVersion: 'signature-a',
        sampleSize: 18,
        sourceEvaluationId: 'evaluation-a',
        measuredAt: '2026-10-20T12:00:00.000Z',
        expiresAt: '2027-01-20T12:00:00.000Z',
        avoidedTokens: { input: 450, output: 80, cacheRead: 120, cacheWrite: 40 },
      },
    ],
  },
  costTierTolerance: 0.15,
} satisfies RoutingConfig;

  it('leaves routing absent when no explicit configuration is provided', () => {
    expect(parseRoutingConfig(undefined)).toBeUndefined();
  });

  it('preserves every configured routing field and accepts configurable effort labels', () => {
    expect(parseRoutingConfig(routingConfiguration)).toMatchObject(routingConfiguration);
  });

  it('preserves valid category capabilities and context minimums', () => {
    const requirements = { capabilities: ['tools', 'images'], contextTokens: 1_000 };
    const configuration = {
      ...routingConfiguration,
      categories: { ...routingConfiguration.categories,
        implementation: { ...routingConfiguration.categories.implementation, requirements } },
    };

    expect(parseRoutingConfig(configuration)).toMatchObject({
      categories: { implementation: { requirements } },
    });
  });

  it.each([
    ['duplicate capabilities', { capabilities: ['tools', 'tools'] }],
    ['unsupported capabilities', { capabilities: ['unknown'] }],
    ['a non-array capability list', { capabilities: 'tools' }],
    ['a zero context floor', { contextTokens: 0 }],
    ['a fractional context floor', { contextTokens: 1.5 }],
    ['an unsafe context floor', { contextTokens: Number.MAX_SAFE_INTEGER + 1 }],
    ['a host-only external bounds setting', { requireExternalBounds: true }],
    ['an unknown requirement field', { extra: true }],
  ])('rejects category requirements with %s', (_label, requirements) => {
    const configuration = {
      ...routingConfiguration,
      categories: { ...routingConfiguration.categories,
        implementation: { ...routingConfiguration.categories.implementation, requirements } },
    };

    expect(() => parseRoutingConfig(configuration)).toThrow(/requirements/);
  });

  it('accepts enabled routing when its configured router fallback resolves', () => {
    expect(parseRoutingConfig({ ...routingConfiguration, enabled: true })).toMatchObject({ enabled: true });
  });

  it('requires a configured router fallback before routing can be enabled', () => {
    const invalidConfiguration = { ...routingConfiguration, enabled: true, cheapFallback: undefined };

    expect(() => parseRoutingConfig(invalidConfiguration)).toThrow('routing.cheapFallback');
  });

  it('requires an effort setting on the first deep research arm', () => {
    const invalidConfiguration: unknown = {
      ...routingConfiguration,
      categories: {
        ...routingConfiguration.categories,
        deep_research: {
          alternatingTargets: [
            modelRef('provider-i', 'model-i'),
            { ...modelRef('provider-j', 'model-j'), effort: 'custom-arm-b-effort' },
          ],
        },
      },
    };

    expect(() => parseRoutingConfig(invalidConfiguration)).toThrow('routing.');
  });

  it('requires an effort setting on the second deep research arm', () => {
    const invalidConfiguration: unknown = {
      ...routingConfiguration,
      categories: {
        ...routingConfiguration.categories,
        deep_research: {
          alternatingTargets: [
            { ...modelRef('provider-i', 'model-i'), effort: 'custom-arm-a-effort' },
            modelRef('provider-j', 'model-j'),
          ],
        },
      },
    };

    expect(() => parseRoutingConfig(invalidConfiguration)).toThrow('routing.');
  });

  it('rejects the configured router target in its own fallback chain', () => {
    const invalidConfiguration: unknown = {
      ...routingConfiguration,
      enabled: true,
      routerFallbacks: [routingConfiguration.cheapFallback],
    };

    expect(() => parseRoutingConfig(invalidConfiguration)).toThrow('routing.');
  });

  it('leaves routing disabled in legacy preferences that have no routing field', () => {
    savePreferences({ lastProvider: 'existing-provider' });

    expect(loadPreferences().routing).toBeUndefined();
  });

  it('persists routing preferences without dropping unrelated preferences', () => {
    savePreferences({ lastProvider: 'existing-provider', lastModel: 'existing-model' });

    savePreferences({ routing: routingConfiguration });

    expect(loadPreferences()).toMatchObject({
      lastProvider: 'existing-provider',
      lastModel: 'existing-model',
      routing: routingConfiguration,
    });
  });

  it.each([
    ['malformed model reference', { ...routingConfiguration, cheapFallback: { providerId: '', modelId: 'model' } }],
    ['blank effort label', {
      ...routingConfiguration,
      categories: { ...routingConfiguration.categories, implementation: { target: modelRef('provider-g', 'model-g'), effort: '  ' } },
    }],
    ['fallback cycle', {
      ...routingConfiguration,
      categories: { ...routingConfiguration.categories, implementation: {
        target: modelRef('provider-g', 'model-g'), fallbacks: [modelRef('provider-g', 'model-g')],
      } },
    }],
    ['negative selector call bound', {
      ...routingConfiguration,
      selector: { ...routingConfiguration.selector, maxExtraCallsPerTask: -1 },
    }],
    ['nonpositive selector timeout', {
      ...routingConfiguration,
      selector: { ...routingConfiguration.selector, timeoutMs: 0 },
    }],
    ['nonpositive selector output bound', {
      ...routingConfiguration,
      selector: { ...routingConfiguration.selector, maxOutputTokens: 0 },
    }],
  ])('reports the preference path for a %s', (_caseName, invalidConfiguration) => {
    expect(() => parseRoutingConfig(invalidConfiguration)).toThrow('routing.');
  });
