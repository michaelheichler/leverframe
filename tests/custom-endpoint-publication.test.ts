import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addCustomEndpointProvider } from '../src/registry/custom-endpoint.js';
import { reconcilePendingCredentialDeletes } from '../src/registry/credential-lifecycle.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';

const boundary = vi.hoisted(() => ({
  deleteProviderCredential: vi.fn(),
  fetchTemplateModels: vi.fn(),
  saveProviderCredential: vi.fn(),
  validateCustomEndpointUrl: vi.fn(),
}));

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    deleteProviderCredential: boundary.deleteProviderCredential,
    saveProviderCredential: boundary.saveProviderCredential,
  };
});
vi.mock('../src/registry/fetch-template-models.js', () => ({
  fetchTemplateModels: boundary.fetchTemplateModels,
}));
vi.mock('../src/registry/url-security.js', () => ({
  revalidateCustomEndpointUrl: vi.fn(),
  validateCustomEndpointUrl: boundary.validateCustomEndpointUrl,
}));

let home: string;
const previousHome = process.env.LEVERFRAME_HOME;

describe('custom endpoint credential publication', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leverframe-custom-publication-'));
    process.env.LEVERFRAME_HOME = home;
    saveRegistry(emptyRegistry());
    vi.clearAllMocks();
    boundary.deleteProviderCredential.mockResolvedValue(true);
    boundary.saveProviderCredential.mockResolvedValue(true);
    boundary.validateCustomEndpointUrl.mockResolvedValue({
      ok: true,
      normalizedUrl: 'https://models.example.com/v1',
    });
    boundary.fetchTemplateModels.mockResolvedValue({
      baseUrl: 'https://models.example.com/v1',
      models: [{
        id: 'model-1',
        name: 'Model 1',
        family: 'model',
        contextWindow: 128_000,
        modelFormat: 'openai',
        npm: '@ai-sdk/openai-compatible',
        apiUrl: 'https://models.example.com/v1',
      }],
    });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
    else process.env.LEVERFRAME_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('holds the credential lock through custom endpoint registry activation', async () => {
    let releaseSave: (() => void) | undefined;
    let saveStarted: (() => void) | undefined;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const saveStart = new Promise<void>(resolve => { saveStarted = resolve; });
    boundary.saveProviderCredential.mockImplementation(async () => {
      saveStarted?.();
      await saveGate;
      return true;
    });
    const publication = addCustomEndpointProvider({
      displayName: 'Example',
      baseUrl: 'https://models.example.com/v1',
      apiKey: 'secret-key',
      kind: 'openai',
    });
    await saveStart;
    const reconciliation = reconcilePendingCredentialDeletes();
    await Promise.resolve();
    await Promise.resolve();

    expect(boundary.deleteProviderCredential).not.toHaveBeenCalled();
    releaseSave?.();
    await expect(publication).resolves.toMatchObject({ added: true });
    await reconciliation;
    expect(boundary.deleteProviderCredential).not.toHaveBeenCalled();
    expect(loadRegistry().providers).toContainEqual(expect.objectContaining({
      id: 'custom-example',
      authRef: 'keyring:provider:custom-example',
    }));
  });
});
