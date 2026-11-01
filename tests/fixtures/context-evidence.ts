import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceStore } from '../../src/context/evidence-store.js';

export function createContextEvidenceFixture(options: { now?: () => number; maxBytes?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-context-evidence-'));
  const key = Buffer.alloc(32, 42);
  const workspaceId = 'fixture-workspace';
  const store = createEvidenceStore({ directory, key, workspaceId, ...options });
  return { directory, key, workspaceId, store, close: () => rmSync(directory, { recursive: true, force: true }) };
}
