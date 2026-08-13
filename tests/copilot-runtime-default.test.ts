/**
 * Verifies the production runtime factory prepares isolated Leverframe directories lazily.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultCopilotRuntime,
  resolveCopilotDirectories,
} from '../src/copilot/runtime.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createDefaultCopilotRuntime', () => {
  it('creates base and working directories under LEVERFRAME_HOME without loading the SDK', () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-copilot-runtime-'));
    roots.push(home);
    const environment = { LEVERFRAME_HOME: home };
    const directories = resolveCopilotDirectories(environment);

    const runtime = createDefaultCopilotRuntime({
      gitHubToken: ['fixture', 'github', 'token'].join('-'),
      nodeVersion: '22.12.0',
      environment,
    });

    expect(runtime).toBeDefined();
    expect(existsSync(directories.baseDirectory)).toBe(true);
    expect(existsSync(directories.workingDirectory)).toBe(true);
  });
});
