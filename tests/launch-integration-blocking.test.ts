import { describe, expect, it, vi } from 'vitest';

import { runLaunchPatchCheckV2 } from '../src/patch-reconcile.js';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import type { PatchRuntime } from '../src/patch-transaction.js';

describe('launch-time Claude integration compatibility', () => {
  it('blocks launch when structural inspection fails', async () => {
    const installation: ClaudeInstallation = {
      logicalPath: '/tmp/claude', canonicalPath: '/tmp/claude', installationPath: '/tmp/claude',
      discoverySource: 'explicit-target', installationKind: 'custom', identity: 'fixture',
      version: '99.0.0', executableType: 'binary',
    };
    const runtime: PatchRuntime = {
      async inspect() { throw new Error('structurally incompatible module graph'); },
      async patch() { return []; },
      async readContent() { return ''; },
    };
    const presenter = {
      notice: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), detail: vi.fn(),
      async confirm() { return false; },
    };

    await expect(runLaunchPatchCheckV2({ installation, runtime }, presenter)).rejects.toThrow(/structurally incompatible/);
  });
});
