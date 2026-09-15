import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runModelsCommand } from '../src/cli-command-models.js';
import { reportBrowsingCatalogStatus } from '../src/provider-catalog-status.js';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  select: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@clack/prompts', async importOriginal => ({
  ...await importOriginal<typeof import('@clack/prompts')>(),
  select: mocks.select,
  spinner: () => ({ start: mocks.start, stop: mocks.stop }),
  log: { warn: mocks.warn, info: mocks.info, error: mocks.error },
}));
vi.mock('../src/provider-catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-catalog.js')>(),
  fetchBrowsingProviderCatalog: mocks.catalog,
}));
vi.mock('../src/ui.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/ui.js')>(),
  leverframeIntro: vi.fn(),
  leverframeOutro: vi.fn(),
}));
vi.mock('../src/config.js', () => ({
  loadPreferences: () => ({ favoriteModels: [{ providerId: 'github-copilot', modelId: 'new-model' }] }),
  savePreferences: mocks.save,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.select.mockResolvedValue('__done__');
  mocks.catalog.mockResolvedValue({
    providers: [{
      id: 'github-copilot', name: 'GitHub Copilot', apiKey: '',
      models: [{ id: 'new-model', name: 'Fresh model', family: 'gpt', brand: 'OpenAI', modelFormat: 'openai' }],
    }],
    statuses: [{ providerId: 'github-copilot', providerName: 'GitHub Copilot', source: 'live', fetchedAt: '2026-09-14' }],
  });
});

describe('model browsing UI', () => {
  it('uses refreshed models in the favorites manager without rewriting saved favorites', async () => {
    expect(await runModelsCommand()).toBe(0);
    expect(mocks.catalog).toHaveBeenCalledOnce();
    expect(mocks.select.mock.calls[0]?.[0].options[0].label).toContain('Fresh model');
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('live model catalog'));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('labels failed-refresh cache as stale browsing-only and shows the timestamp and reason', () => {
    reportBrowsingCatalogStatus([{
      providerId: 'github-copilot', providerName: 'GitHub Copilot', source: 'cache',
      fetchedAt: '2026-09-01', reason: 'Authentication expired',
    }]);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringMatching(/stale cache.*browsing only.*2026-09-01.*Authentication expired/));
  });

  it('surfaces partial discovery warnings even when valid live models remain', () => {
    reportBrowsingCatalogStatus([{
      providerId: 'github-copilot', providerName: 'GitHub Copilot', source: 'live',
      reason: 'Skipped one unsupported record',
    }]);
    expect(mocks.warn).toHaveBeenCalledWith('GitHub Copilot: Skipped one unsupported record');
  });

  it('stops the spinner and reports a catalog loading failure', async () => {
    mocks.catalog.mockRejectedValueOnce(new Error('Registry cannot be read'));
    expect(await runModelsCommand()).toBe(1);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Registry cannot be read'));
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
