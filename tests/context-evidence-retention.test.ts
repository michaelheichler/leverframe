import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createEvidenceStore } from '../src/context/evidence-store.js';
import { createContextEvidenceFixture } from './fixtures/context-evidence.js';

const retainedText = 'Original evidence remains available. '.repeat(20);

describe('evidence retention and filesystem boundaries', () => {
  it('rejects evidence after the retention period', async () => {
    let now = Date.UTC(2026, 0, 1);
    const fixture = createContextEvidenceFixture({ now: () => now });
    await withFixture(fixture, async () => {
      const reference = await fixture.store.put('session-a', retainedText);
      now += 31 * 24 * 60 * 60 * 1000;
      await expect(fixture.store.get('session-a', reference)).rejects.toThrow();
      expect(readdirSync(fixture.directory).some(name => name.includes(reference))).toBe(false);
    });
  });

  it('preserves a live reference when a reopened store rejects a new record at a lower cap', async () => {
    const fixture = createContextEvidenceFixture({ maxBytes: 4096 });
    await withFixture(fixture, async () => {
      const reference = await fixture.store.put('session-a', retainedText);
      const smallerStore = createEvidenceStore({
        directory: fixture.directory, key: fixture.key, workspaceId: fixture.workspaceId, maxBytes: 1,
      });
      await expect(smallerStore.put('session-b', retainedText)).rejects.toThrow();
      await expect(smallerStore.get('session-a', reference)).resolves.toBe(retainedText);
    });
  });

  it('removes expired records before retaining new evidence', async () => {
    let now = Date.UTC(2026, 0, 1);
    const fixture = createContextEvidenceFixture({ now: () => now, maxBytes: 2300 });
    await withFixture(fixture, async () => {
      const expiredReference = await fixture.store.put('session-a', retainedText);
      now += 31 * 24 * 60 * 60 * 1000;
      await fixture.store.put('session-b', retainedText);
      await expect(fixture.store.get('session-a', expiredReference)).rejects.toThrow();
    });
  });

  it('does not follow a symlinked evidence directory outside its configured path', async () => {
    const external = mkdtempSync(join(tmpdir(), 'leverframe-evidence-outside-'));
    const link = mkdtempSync(join(tmpdir(), 'leverframe-evidence-link-'));
    rmSync(link, { recursive: true, force: true });
    symlinkSync(external, link);
    const store = createEvidenceStore({ directory: link, key: Buffer.alloc(32, 43), workspaceId: 'fixture-workspace' });
    try {
      await expect(store.put('session-a', retainedText)).rejects.toThrow();
      expect(readdirSync(external)).toEqual([]);
    } finally {
      rmSync(link, { force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe('evidence identity reuse', () => {
  it('reuses a live session reference after reopening without growing storage past its cap', async () => {
    const fixture = createContextEvidenceFixture({ maxBytes: 100_000 });
    await withFixture(fixture, async () => {
      const reference = await fixture.store.put('session-a', retainedText);
      const file = readdirSync(fixture.directory).find(name => name.includes(reference));
      expect(file).toBeDefined();
      const existingBytes = statSync(join(fixture.directory, file!)).size;
      const reopened = createEvidenceStore({
        directory: fixture.directory, key: fixture.key, workspaceId: fixture.workspaceId, maxBytes: existingBytes,
      });
      await expect(reopened.put('session-a', retainedText)).resolves.toBe(reference);
    });
  });

  it('stores the same content under separate references for separate sessions', async () => {
    const fixture = createContextEvidenceFixture();
    await withFixture(fixture, async () => {
      const first = await fixture.store.put('session-a', retainedText);
      const second = await fixture.store.put('session-b', retainedText);
      expect(second).not.toBe(first);
      await expect(fixture.store.get('session-a', second)).rejects.toThrow();
    });
  });

  it('keeps the original expiry after reusing the same evidence', async () => {
    let now = Date.UTC(2026, 0, 1);
    const fixture = createContextEvidenceFixture({ now: () => now });
    await withFixture(fixture, async () => {
      const originalReference = await fixture.store.put('session-a', retainedText);
      now += 29 * 24 * 60 * 60 * 1000;
      const reusedReference = await fixture.store.put('session-a', retainedText);
      expect(reusedReference).toBe(originalReference);
      now += 2 * 24 * 60 * 60 * 1000;
      await expect(fixture.store.get('session-a', reusedReference)).rejects.toThrow();
    });
  });
});

async function withFixture(fixture: ReturnType<typeof createContextEvidenceFixture>, action: () => Promise<void>) {
  try {
    await action();
  } finally {
    fixture.close();
  }
}
