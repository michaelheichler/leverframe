import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing-catalog.js';
import { cachedModel, input, provider } from './model-routing-fixtures.js';

it('maps reported capability signals without inferring them from provider identity', () => {
  const reported = provider({
    id: 'arbitrary-provider',
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [{
      ...cachedModel('reported-capabilities'), reasoning: false, vision: false, supportedParameters: ['tools'],
    }] },
  });

  const snapshot = buildRoutingCatalog(input([reported]));
  const model = snapshot.models[0];

  expect(model?.capabilities).toMatchObject({
    reasoning: false,
    images: false,
    tools: true,
    source: 'supplier-metadata',
  });
  expect(model?.confirmedCapabilities).toEqual(expect.arrayContaining(['reasoning', 'images', 'tools']));
});

it('keeps missing capability observations unconfirmed and leaves defaults false', () => {
  const unreported = provider({
    id: 'unclassified-provider',
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('unreported-capabilities')] },
  });

  const snapshot = buildRoutingCatalog(input([unreported]));
  const model = snapshot.models[0];

  expect(model?.capabilities).toMatchObject({ reasoning: false, images: false, source: 'inferred' });
  expect(model?.confirmedCapabilities).toEqual([]);
  expect(model?.contextWindowConfirmed).toBe(false);
});
