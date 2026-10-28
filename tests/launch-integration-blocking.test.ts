import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runLaunchPatchCheckV2 } from '../src/patch-reconcile.js';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import type { PatchRuntime } from '../src/patch-transaction.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-launch-blocking-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

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

    await expect(runLaunchPatchCheckV2({ installation, runtime, freshProviders: [] }, presenter))
      .rejects.toThrow(/structurally incompatible/);
  });
});
