import { describe, expect, it } from 'vitest';
import { formatModelCatalogLines } from '../src/server/catalog.js';
import { exposedGatewayAliasId, type ServerModelInfo } from '../src/server/models.js';

describe('server model catalog formatting', () => {
  it('truncates displayed columns at the widths used for alignment', () => {
    const name = 'N'.repeat(35);
    const model: ServerModelInfo = {
      id: 'm'.repeat(60),
      name,
      isFree: false,
      brand: 'Provider',
      sourceBackend: 'provider',
      modelFormat: 'openai',
      upstreamModelId: 'm'.repeat(60),
      providerId: 'provider',
    };
    const anthropicId = exposedGatewayAliasId(model);
    const lines = formatModelCatalogLines([model]);

    const row = lines.find(line => line.includes(model.id));
    expect(row).toBeDefined();
    expect(row).toContain(`${'N'.repeat(27)}…`);
    expect(row).not.toContain(name);
    expect(row).toContain(`${anthropicId.slice(0, 45)}…`);
    expect(row).not.toContain(anthropicId);
  });
});
