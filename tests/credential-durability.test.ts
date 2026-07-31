import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runIsolatedKeyringOperation } from '../src/credential-store.js';

interface FakeState {
  [service: string]: Record<string, string>;
}

function fakeKeyring(options: { enumerable?: boolean } = {}): { moduleUrl: string; statePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-fake-keyring-'));
  const statePath = join(directory, 'state.json');
  const modulePath = join(directory, 'keyring.mjs');
  const enumerationSource = options.enumerable === false
    ? ''
    : 'export const findCredentials = service => Object.entries(load()[service] ?? {}).map(([account, password]) => ({ account, password }));';
  writeFileSync(statePath, '{}');
  writeFileSync(modulePath, `
import { readFileSync, writeFileSync } from 'node:fs';
const statePath = ${JSON.stringify(statePath)};
const load = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const save = state => writeFileSync(statePath, JSON.stringify(state));
export class Entry {
  constructor(service, account) { this.service = service; this.account = account; }
  getPassword() { return load()[this.service]?.[this.account] ?? null; }
  setPassword(value) { const state = load(); (state[this.service] ??= {})[this.account] = value; save(state); return true; }
  deletePassword() { const state = load(); const had = Object.hasOwn(state[this.service] ?? {}, this.account); if (state[this.service]) delete state[this.service][this.account]; save(state); return had; }
}
${enumerationSource}
`);
  return { moduleUrl: pathToFileURL(modulePath).href, statePath };
}

function state(path: string): FakeState {
  return JSON.parse(readFileSync(path, 'utf8')) as FakeState;
}

function saveState(path: string, value: FakeState): void {
  writeFileSync(path, JSON.stringify(value));
}

function operation(
  moduleUrl: string,
  input: Parameters<typeof runIsolatedKeyringOperation>[0],
) {
  return runIsolatedKeyringOperation(input, {
    moduleUrl,
    skipAvailabilityCheck: true,
    timeoutMs: 5_000,
  });
}

describe('generational keyring durability', () => {
  it('publishes v3 generation-scoped chunks with count and SHA-256', async () => {
    const fake = fakeKeyring();
    const value = 'credential-'.repeat(400);
    await expect(operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account: 'provider:test', value,
    })).resolves.toEqual({ ok: true, value: null });

    const saved = state(fake.statePath);
    const marker = saved.leverframe?.['provider:test'];
    expect(marker).toMatch(/^__relay_chunked__:v3:[0-9a-f-]+:4:[0-9a-f]{64}$/);
    const match = /^__relay_chunked__:v3:([^:]+):(\d+):([0-9a-f]{64})$/.exec(marker!);
    expect(match?.[3]).toBe(createHash('sha256').update(value).digest('hex'));
    const generation = match?.[1];
    expect(Object.keys(saved['leverframe-chunks'] ?? {}).filter(key => key.startsWith(`provider:test::chunk::${generation}::`))).toHaveLength(4);
    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account: 'provider:test',
    })).resolves.toEqual({ ok: true, value });
  });

  it('fails closed when a published chunk is missing or tampered', async () => {
    const fake = fakeKeyring();
    const value = 'x'.repeat(2401);
    await operation(fake.moduleUrl, { operation: 'write', service: 'leverframe', account: 'provider:test', value });
    const saved = state(fake.statePath);
    const chunk = Object.keys(saved['leverframe-chunks']!)[0]!;
    saved['leverframe-chunks']![chunk] = 'tampered';
    saveState(fake.statePath, saved);

    const result = await operation(fake.moduleUrl, { operation: 'read', service: 'leverframe', account: 'provider:test' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^integrity: .*digest does not match/);
  });

  it('reads and migrates a legacy chunk marker without deleting legacy services', async () => {
    const fake = fakeKeyring();
    const value = 'legacy-value-'.repeat(150);
    saveState(fake.statePath, {
      leverframe: {
        'provider:legacy': '__relay_chunked__:2',
        'provider:legacy::chunk::0': value.slice(0, 1200),
        'provider:legacy::chunk::1': value.slice(1200),
      },
    });

    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account: 'provider:legacy',
    })).resolves.toEqual({ ok: true, value });
    const migrated = state(fake.statePath);
    expect(migrated.leverframe?.['provider:legacy']).toMatch(/^__relay_chunked__:v3:/);
    expect(migrated['leverframe-chunks']).toBeDefined();
  });

  it('rolls back an unpublished generation after restart', async () => {
    const fake = fakeKeyring();
    const account = 'provider:restart';
    const previous = 'previous-secret';
    const candidate = 'candidate-'.repeat(180);
    const generation = '12345678-1234-4123-8123-123456789abc';
    const marker = {
      version: 3,
      generation,
      count: 2,
      digest: createHash('sha256').update(candidate).digest('hex'),
    };
    saveState(fake.statePath, {
      leverframe: { [account]: previous },
      'leverframe-chunks': {
        [`${account}::chunk::${generation}::0`]: candidate.slice(0, 1200),
        [`${account}::chunk::${generation}::1`]: candidate.slice(1200),
      },
      'leverframe-journal': {
        [account]: JSON.stringify({
          schemaVersion: 1,
          mode: 'preparing',
          previous: { kind: 'short', digest: createHash('sha256').update(previous).digest('hex') },
          candidate: { kind: 'chunks', marker },
          retired: [],
        }),
      },
    });

    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: previous });
    expect(Object.keys(state(fake.statePath)['leverframe-chunks'] ?? {})).toEqual([]);
  });

  it('deletes with a durable guard and remains idempotently deleted', async () => {
    const fake = fakeKeyring();
    const account = 'provider:delete';
    await operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'secret-'.repeat(400),
    });
    await expect(operation(fake.moduleUrl, {
      operation: 'delete', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: null });
    await expect(operation(fake.moduleUrl, {
      operation: 'delete', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: null });
    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: null, deleted: true });

    const deleted = state(fake.statePath);
    expect(deleted['leverframe-deleted']?.[account]).toBe('v1:deleted');
    expect(deleted.leverframe?.[account]).toBeUndefined();
    expect(Object.keys(deleted['leverframe-chunks'] ?? {})).toEqual([]);
  });

  it('self-heals an active journal that no longer matches the published credential', async () => {
    const fake = fakeKeyring();
    const account = 'provider:healed';
    saveState(fake.statePath, {
      leverframe: { [account]: 'live-secret' },
      'leverframe-journal': {
        [account]: JSON.stringify({
          schemaVersion: 1,
          mode: 'active',
          active: { kind: 'short', digest: createHash('sha256').update('stale-secret').digest('hex') },
          retired: [],
        }),
      },
    });

    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: 'live-secret' });
    const journal = JSON.parse(state(fake.statePath)['leverframe-journal']![account]!) as { mode: string; active: { digest: string } };
    expect(journal.mode).toBe('active');
    expect(journal.active.digest).toBe(createHash('sha256').update('live-secret').digest('hex'));
  });

  it('repair rebuilds a corrupt journal while keeping a readable credential', async () => {
    const fake = fakeKeyring();
    const account = 'provider:repairable';
    saveState(fake.statePath, {
      leverframe: { [account]: 'kept-secret' },
      'leverframe-journal': { [account]: '{not json' },
    });

    await expect(operation(fake.moduleUrl, {
      operation: 'repair', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: 'kept-secret' });
    expect(JSON.parse(state(fake.statePath)['leverframe-journal']![account]!)).toMatchObject({ mode: 'active' });
  });

  it('repair clears all entries for an account whose credential is unreadable', async () => {
    const fake = fakeKeyring();
    const account = 'provider:lost';
    saveState(fake.statePath, {
      leverframe: { [account]: '__relay_chunked__:v3:12345678-1234-4123-8123-123456789abc:2:' + 'a'.repeat(64) },
      'leverframe-journal': { [account]: '{not json' },
    });

    await expect(operation(fake.moduleUrl, {
      operation: 'repair', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: null });
    const cleared = state(fake.statePath);
    expect(cleared.leverframe?.[account]).toBeUndefined();
    expect(cleared['leverframe-journal']?.[account]).toBeUndefined();
  });

  it('retains a pending deletion when the backend cannot verify inventory', async () => {
    const fake = fakeKeyring({ enumerable: false });
    const account = 'provider:no-inventory';
    await operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'secret-'.repeat(400),
    });

    const result = await operation(fake.moduleUrl, {
      operation: 'delete', service: 'leverframe', account,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^integrity: keyring credential inventory is unavailable/);
    expect(state(fake.statePath)['leverframe-deleted']?.[account]).toBe('v1:pending');
  });
});
