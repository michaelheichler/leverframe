/**
 * Verifies GitHub Copilot provider publication around the real registry boundary.
 * GitHub and the OS credential store are replaced with deterministic boundary doubles.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateProvider } from '../src/registry/provider-auth.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import { withCredentialMutationLock } from '../src/registry/lock.js';

const ACCESS_TOKEN = ['fixture', 'github', 'oauth', 'token'].join('-');

const boundary = vi.hoisted(() => ({
  diagnoseCredentialStorage: vi.fn(),
  cancelCredentialDelete: vi.fn(),
  journalCredentialWrite: vi.fn(),
  reconcilePendingCredentialDeletes: vi.fn(),
  refreshProviderModels: vi.fn(),
  runGitHubCopilotDeviceCodeFlow: vi.fn(),
  runOpenAiDeviceCodeFlow: vi.fn(),
  saveProviderCredential: vi.fn(),
  spinnerStart: vi.fn(),
  spinnerStop: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  spinner: () => ({
    start: boundary.spinnerStart,
    stop: boundary.spinnerStop,
  }),
}));

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui.js', () => ({ printOAuthStepsPanel: vi.fn() }));
vi.mock('../src/credential-store.js', () => ({
  diagnoseCredentialStorage: boundary.diagnoseCredentialStorage,
}));
vi.mock('../src/env.js', () => ({
  saveProviderCredential: boundary.saveProviderCredential,
}));
vi.mock('../src/oauth/openai.js', () => ({
  runOpenAiDeviceCodeFlow: boundary.runOpenAiDeviceCodeFlow,
}));
vi.mock('../src/oauth/github-copilot.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/oauth/github-copilot.js')>();
  return {
    ...actual,
    runGitHubCopilotDeviceCodeFlow: boundary.runGitHubCopilotDeviceCodeFlow,
  };
});
vi.mock('../src/registry/credential-lifecycle.js', () => ({
  cancelCredentialDelete: boundary.cancelCredentialDelete,
  journalCredentialWrite: boundary.journalCredentialWrite,
  reconcilePendingCredentialDeletes: boundary.reconcilePendingCredentialDeletes,
}));
vi.mock('../src/registry/refresh-models.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/refresh-models.js')>();
  return {
    ...actual,
    refreshProviderModels: boundary.refreshProviderModels,
  };
});

let home: string;
const previousHome = process.env.LEVERFRAME_HOME;

function registerProviderAuthTestLifecycle(): void {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leverframe-github-copilot-auth-'));
    process.env.LEVERFRAME_HOME = home;
    saveRegistry(emptyRegistry());
    vi.clearAllMocks();
    boundary.diagnoseCredentialStorage.mockResolvedValue([]);
    boundary.cancelCredentialDelete.mockResolvedValue(undefined);
    boundary.journalCredentialWrite.mockResolvedValue(undefined);
    boundary.reconcilePendingCredentialDeletes.mockResolvedValue(undefined);
    boundary.refreshProviderModels.mockResolvedValue({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      ok: true,
      modelCount: 1,
    });
    boundary.saveProviderCredential.mockResolvedValue(true);
    boundary.runGitHubCopilotDeviceCodeFlow.mockResolvedValue({
      tokens: { access_token: ACCESS_TOKEN },
    });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
    else process.env.LEVERFRAME_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
}

describe('authenticateProvider github-copilot success', () => {
  registerProviderAuthTestLifecycle();

  it('stores the token only through the OAuth keyring reference', async () => {
    const result = await authenticateProvider('github-copilot');

    expect(result.providerId).toBe('github-copilot');
    expect(boundary.runGitHubCopilotDeviceCodeFlow).toHaveBeenCalledTimes(1);
    expect(boundary.saveProviderCredential).toHaveBeenCalledTimes(1);
    const [authRef, serializedCredential] = boundary.saveProviderCredential.mock.calls[0] as [
      string,
      string,
    ];
    expect(authRef).toBe('keyring:oauth:provider:github-copilot');
    expect(JSON.parse(serializedCredential)).toMatchObject({
      type: 'oauth',
      access: ACCESS_TOKEN,
      refresh: '',
    });

    const registry = loadRegistry();
    expect(registry.providers).toContainEqual(expect.objectContaining({
      id: 'github-copilot',
      templateId: 'github-copilot',
      authType: 'oauth',
      authRef: 'keyring:oauth:provider:github-copilot',
      api: expect.objectContaining({ npm: '@github/copilot-sdk' }),
    }));
    expect(JSON.stringify(registry)).not.toContain(ACCESS_TOKEN);
  });

  it('discovers Copilot models after publishing the credential', async () => {
    await authenticateProvider('github-copilot');

    expect(boundary.refreshProviderModels).toHaveBeenCalledWith('github-copilot', ACCESS_TOKEN);
  });

  it('holds the credential lock until registry activation and cleanup cancellation complete', async () => {
    let releaseSave: (() => void) | undefined;
    let saveStarted: (() => void) | undefined;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const saveStart = new Promise<void>(resolve => { saveStarted = resolve; });
    boundary.saveProviderCredential.mockImplementation(async () => {
      saveStarted?.();
      await saveGate;
      return true;
    });
    const authentication = authenticateProvider('github-copilot');
    await saveStart;
    let contenderEntered = false;
    const contender = withCredentialMutationLock(
      'keyring:oauth:provider:github-copilot',
      async () => { contenderEntered = true; },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(contenderEntered).toBe(false);
    releaseSave?.();
    await authentication;
    await contender;
    expect(contenderEntered).toBe(true);
    expect(loadRegistry().providers).toContainEqual(expect.objectContaining({ id: 'github-copilot' }));
    expect(boundary.cancelCredentialDelete).toHaveBeenCalledWith('keyring:oauth:provider:github-copilot');
  });
});

describe('authenticateProvider github-copilot failure safety', () => {
  registerProviderAuthTestLifecycle();

  it('does not publish a registry entry when credential storage fails', async () => {
    boundary.saveProviderCredential.mockResolvedValue(false);

    await expect(authenticateProvider('github-copilot'))
      .rejects.toThrow(/Could not save OAuth tokens/);
    expect(loadRegistry().providers).toHaveLength(0);
    expect(boundary.refreshProviderModels).not.toHaveBeenCalled();
  });

  it('does not write credentials or registry state after cancellation', async () => {
    boundary.runGitHubCopilotDeviceCodeFlow.mockRejectedValue(
      new Error('GitHub Copilot device authorization aborted'),
    );

    await expect(authenticateProvider('github-copilot'))
      .rejects.toThrow(/authorization aborted/);
    expect(boundary.saveProviderCredential).not.toHaveBeenCalled();
    expect(loadRegistry().providers).toHaveLength(0);
  });


  it('forwards a caller cancellation signal to the device flow', async () => {
    const controller = new AbortController();

    await authenticateProvider('github-copilot', { signal: controller.signal });

    expect(boundary.runGitHubCopilotDeviceCodeFlow).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ signal: controller.signal }),
    );
  });


  it('warns instead of failing when the credential is saved but model discovery reports failure', async () => {
    boundary.refreshProviderModels.mockResolvedValue({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      ok: false,
      reason: 'runtime unavailable',
    });

    const result = await authenticateProvider('github-copilot');

    expect(result.providerId).toBe('github-copilot');
    expect(loadRegistry().providers).toContainEqual(expect.objectContaining({ id: 'github-copilot' }));
    expect(boundary.spinnerStop).not.toHaveBeenCalledWith('Models refreshed');
    expect(boundary.spinnerStop).toHaveBeenCalledWith(expect.stringContaining('runtime unavailable'));
  });

  it('does not claim cached models were refreshed after live discovery fails', async () => {
    boundary.refreshProviderModels.mockResolvedValue({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      ok: true,
      skipped: true,
      modelCount: 1,
      reason: 'Live model discovery failed. Kept your existing cached model list.',
    });

    await authenticateProvider('github-copilot');

    expect(boundary.spinnerStop).not.toHaveBeenCalledWith('Models refreshed');
    expect(boundary.spinnerStop).toHaveBeenCalledWith(expect.stringContaining('Live model discovery failed'));
  });

  it('warns instead of failing when the credential is saved but model discovery throws', async () => {
    boundary.refreshProviderModels.mockRejectedValue(new Error('network blip'));

    const result = await authenticateProvider('github-copilot');

    expect(result.providerId).toBe('github-copilot');
    expect(loadRegistry().providers).toContainEqual(expect.objectContaining({ id: 'github-copilot' }));
    expect(boundary.spinnerStop).not.toHaveBeenCalledWith('Models refreshed');
    expect(boundary.spinnerStop).toHaveBeenCalledWith(expect.stringContaining('network blip'));
  });
});
