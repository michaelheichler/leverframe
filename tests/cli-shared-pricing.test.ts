import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { cachedSwitchyardCatalog, orderedSwitchyardModels, switchyardModelLine } from '../src/cli-switchyard-catalog.js';
import { getAppHome } from '../src/paths.js';
import { getUserPricingCachePath } from '../src/registry/pricing.js';
import { saveRegistry } from '../src/registry/io.js';
import { cachedModel, provider } from './model-routing-fixtures.js';

it('shows and sorts the known API-equivalent estimate from a shared standard rate', () => {
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  const isolatedHome = join(testHome!, `cli-shared-pricing-${randomUUID()}`);
  const priorHome = process.env['HOME'];
  const priorProfile = process.env['USERPROFILE'];
  const priorLeverframeHome = process.env['LEVERFRAME_HOME'];
  process.env['HOME'] = isolatedHome;
  process.env['USERPROFILE'] = join(isolatedHome, 'profile');
  process.env['LEVERFRAME_HOME'] = join(isolatedHome, 'app');

  try {
    expect(relative(testHome!, getAppHome())).not.toMatch(/^\.\.(?:\/|$)/);
    const fetchedAt = '2026-10-01T00:00:00.000Z';
    const unpriced = provider({
      id: 'a-unpriced-provider',
      templateId: 'custom',
      modelsCache: { fetchedAt, models: [cachedModel('unpriced-cli-model')] },
    });
    const shared = provider({
      id: 'z-shared-rate-provider',
      templateId: 'anthropic-api',
      modelsCache: { fetchedAt, models: [cachedModel('shared-standard-cli-model')] },
    });
    saveRegistry({ schemaVersion: 1, providers: [unpriced, shared] });
    const pricingPath = getUserPricingCachePath();
    expect(relative(testHome!, pricingPath)).not.toMatch(/^\.\.(?:\/|$)/);
    mkdirSync(getAppHome(), { recursive: true });
    writeFileSync(pricingPath, JSON.stringify({ generated_at: fetchedAt, models: [{
      model_id: 'shared-standard-cli-model', pricing: [{ platform: 'anthropic', tier: 'standard',
        input_per_1m_tokens: 3, output_per_1m_tokens: 4 }],
    }] }));
    const ordered = orderedSwitchyardModels(cachedSwitchyardCatalog());
    const sharedIndex = ordered.findIndex(model => model.ref.providerId === shared.id
      && model.ref.modelId === 'shared-standard-cli-model');
    const unknownIndex = ordered.findIndex(model => model.ref.providerId === unpriced.id
      && model.ref.modelId === 'unpriced-cli-model');

    expect(sharedIndex).toBeGreaterThanOrEqual(0);
    expect(unknownIndex).toBeGreaterThan(sharedIndex);
    expect(switchyardModelLine(ordered[sharedIndex]!)).toContain('input 3, output 4');
    expect(switchyardModelLine(ordered[sharedIndex]!)).toContain('API-equivalent example $7');
  } finally {
    expect(relative(testHome!, isolatedHome)).not.toMatch(/^\.\.(?:\/|$)/);
    rmSync(isolatedHome, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = priorHome;
    if (priorProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = priorProfile;
    if (priorLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = priorLeverframeHome;
  }
});
