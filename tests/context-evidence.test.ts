import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEvidenceStore } from '../src/context/evidence-store.js';
import { createContextEvidenceFixture } from './fixtures/context-evidence.js';

const record = 'Original tool output with exact spacing.\nSecond line stays intact. ';

describe('session evidence storage', () => {
  it('recovers exact evidence after a store is recreated', async () => {
    const fixture = createContextEvidenceFixture();
    await withFixture(fixture, async () => {
      const reference = await fixture.store.put('session-a', record);
      const restarted = createEvidenceStore({ directory: fixture.directory, key: fixture.key, workspaceId: fixture.workspaceId });
      await expect(restarted.get('session-a', reference)).resolves.toBe(record);
    });
  });

  it('rejects retrieval from a different session', async () => {
    const fixture = createContextEvidenceFixture();
    await withFixture(fixture, async () => {
      const reference = await fixture.store.put('session-a', record);
      await expect(fixture.store.get('session-b', reference)).rejects.toThrow();
    });
  });

  it('rejects a forged reference', async () => {
    const fixture = createContextEvidenceFixture();
    await withFixture(fixture, async () => expect(fixture.store.get('session-a', 'forged-reference')).rejects.toThrow());
  });

  it('rejects evidence whose persisted bytes have changed', async () => {
    const fixture = createContextEvidenceFixture();
    await withFixture(fixture, async () => {
      const reference = await fixture.store.put('session-a', record);
      corruptStoredEvidence(fixture.directory, reference);
      await expect(fixture.store.get('session-a', reference)).rejects.toThrow();
    });
  });

  it('retrieves healthy evidence beside corruption and cleans unrelated expired data', async () => {
    let now = Date.UTC(2026, 0, 1);
    const fixture = createContextEvidenceFixture({ now: () => now });
    await withFixture(fixture, async () => {
      const expiredReference = await fixture.store.put('session-b', 'Expired record.');
      now += 31 * 24 * 60 * 60 * 1000;
      const damagedReference = await fixture.store.put('session-a', 'Record to corrupt.');
      const healthyContent = 'Healthy record remains available.';
      const healthyReference = await fixture.store.put('session-a', healthyContent);
      corruptStoredEvidence(fixture.directory, damagedReference);
      await expect(fixture.store.get('session-a', healthyReference)).resolves.toBe(healthyContent);
      await expect(fixture.store.get('session-a', damagedReference)).rejects.toThrow();
      await expect(fixture.store.put('session-c', 'New record.')).rejects.toThrow();
      const entries = readdirSync(fixture.directory);
      expect(entries.some(name => name.includes(healthyReference))).toBe(true);
      expect(entries.some(name => name.includes(damagedReference))).toBe(true);
      expect(entries.some(name => name.includes(expiredReference))).toBe(false);
    });
  });

  it('rejects evidence that exceeds the configured encrypted storage cap', async () => {
    const fixture = createContextEvidenceFixture({ maxBytes: 1 });
    await withFixture(fixture, async () => expect(fixture.store.put('session-a', record)).rejects.toThrow());
  });

});

async function withFixture(fixture: ReturnType<typeof createContextEvidenceFixture>, action: () => Promise<void>) {
  try {
    await action();
  } finally {
    fixture.close();
  }
}

function corruptStoredEvidence(directory: string, reference: string) {
  const file = readdirSync(directory).find(name => name.includes(reference));
  if (file === undefined) throw new Error('evidence storage did not create a record');
  const path = join(directory, file);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 1;
  writeFileSync(path, bytes);
}
