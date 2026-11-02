import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceStore } from '../../src/context/evidence-store.js';

export function createContextEvidenceFixture(options: { now?: () => number; maxBytes?: number } = {}) {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'leverframe-context-evidence-'));
  const directory = join(rootDirectory, 'evidence');
  mkdirSync(directory, { mode: 0o700 });
  const key = Buffer.alloc(32, 42);
  const workspaceId = 'fixture-workspace';
  const store = createEvidenceStore({ directory, key, workspaceId, ...options });
  return { directory, key, workspaceId, store, close: () => rmSync(rootDirectory, { recursive: true, force: true }) };
}
