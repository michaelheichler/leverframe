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

interface FakeFailure {
  operation: 'get' | 'set' | 'delete' | 'find';
  service: string;
  account: string;
  remaining: number;
  message: string;
}

interface FakeControl {
  failures: FakeFailure[];
}

function fakeKeyring(options: { enumerable?: boolean } = {}): { moduleUrl: string; statePath: string; controlPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-fake-keyring-'));
  const statePath = join(directory, 'state.json');
  const controlPath = join(directory, 'control.json');
  const modulePath = join(directory, 'keyring.mjs');
  const enumerationSource = options.enumerable === false
    ? ''
    : `export const findCredentials = service => {
  maybeFail('find', service, '');
  return Object.entries(load()[service] ?? {}).map(([account, password]) => ({ account, password }));
};`;
  writeFileSync(statePath, '{}');
  writeFileSync(controlPath, '{"failures":[]}');
  writeFileSync(modulePath, `
import { readFileSync, writeFileSync } from 'node:fs';
const statePath = ${JSON.stringify(statePath)};
const controlPath = ${JSON.stringify(controlPath)};
const load = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const save = state => writeFileSync(statePath, JSON.stringify(state));
const loadControl = () => JSON.parse(readFileSync(controlPath, 'utf8'));
const maybeFail = (operation, service, account) => {
  const control = loadControl();
  const failure = control.failures.find(item => item.operation === operation && item.service === service && item.account === account && item.remaining > 0);
  if (!failure) return;
  failure.remaining -= 1;
  writeFileSync(controlPath, JSON.stringify(control));
  throw new Error(failure.message);
};
export class Entry {
  constructor(service, account) { this.service = service; this.account = account; }
  getPassword() { maybeFail('get', this.service, this.account); return load()[this.service]?.[this.account] ?? null; }
  setPassword(value) { maybeFail('set', this.service, this.account); const state = load(); (state[this.service] ??= {})[this.account] = value; save(state); return true; }
  deletePassword() { maybeFail('delete', this.service, this.account); const state = load(); const had = Object.hasOwn(state[this.service] ?? {}, this.account); if (state[this.service]) delete state[this.service][this.account]; save(state); return had; }
}
${enumerationSource}
`);
  return { moduleUrl: pathToFileURL(modulePath).href, statePath, controlPath };
}

function state(path: string): FakeState {
  return JSON.parse(readFileSync(path, 'utf8')) as FakeState;
}

function saveState(path: string, value: FakeState): void {
  writeFileSync(path, JSON.stringify(value));
}

function saveControl(path: string, value: FakeControl): void {
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

  it('self-heals a stale active journal when the published credential is missing', async () => {
    const fake = fakeKeyring();
    const account = 'provider:missing';
    saveState(fake.statePath, {
      'leverframe-journal': {
        [account]: JSON.stringify({
          schemaVersion: 1,
          mode: 'active',
          active: { kind: 'short', digest: createHash('sha256').update('gone-secret').digest('hex') },
          retired: [],
        }),
      },
    });

    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: null });
    expect(state(fake.statePath)['leverframe-journal']?.[account]).toBeUndefined();
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

  it('completes a pending delete before publishing a replacement', async () => {
    const fake = fakeKeyring();
    const account = 'provider:replace-pending';
    const previous = 'previous-'.repeat(400);
    const replacement = 'replacement-secret';
    await operation(fake.moduleUrl, { operation: 'write', service: 'leverframe', account, value: previous });
    const pending = state(fake.statePath);
    const activeJournal = JSON.parse(pending['leverframe-journal']![account]!) as { active: unknown };
    pending['leverframe-journal']![account] = JSON.stringify({
      schemaVersion: 1,
      mode: 'delete',
      active: activeJournal.active,
      retired: [activeJournal.active],
    });
    (pending['leverframe-deleted'] ??= {})[account] = 'v1:pending';
    saveState(fake.statePath, pending);

    await expect(operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: replacement,
    })).resolves.toEqual({ ok: true, value: null });
    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: replacement });
    const recovered = state(fake.statePath);
    expect(recovered['leverframe-deleted']?.[account]).toBeUndefined();
    expect(Object.keys(recovered['leverframe-chunks'] ?? {})).toEqual([]);
    expect(JSON.parse(recovered['leverframe-journal']![account]!)).toMatchObject({ mode: 'active' });
  });

  it('resumes a pending delete when the primary and some chunks are already absent', async () => {
    const fake = fakeKeyring();
    const account = 'provider:partial-delete';
    await operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'previous-'.repeat(400),
    });
    const pending = state(fake.statePath);
    const activeJournal = JSON.parse(pending['leverframe-journal']![account]!) as { active: unknown };
    pending['leverframe-journal']![account] = JSON.stringify({
      schemaVersion: 1,
      mode: 'delete',
      active: activeJournal.active,
      retired: [activeJournal.active],
    });
    (pending['leverframe-deleted'] ??= {})[account] = 'v1:pending';
    delete pending.leverframe![account];
    const firstChunk = Object.keys(pending['leverframe-chunks']!)[0]!;
    delete pending['leverframe-chunks']![firstChunk];
    saveState(fake.statePath, pending);

    await expect(operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'replacement-secret',
    })).resolves.toEqual({ ok: true, value: null });
    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: 'replacement-secret' });
  });

  it('keeps resumed deletion pending after a backend failure and converges on retry', async () => {
    const fake = fakeKeyring();
    const account = 'provider:retry-delete';
    await operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'previous-'.repeat(400),
    });
    const pending = state(fake.statePath);
    const activeJournal = JSON.parse(pending['leverframe-journal']![account]!) as { active: unknown };
    pending['leverframe-journal']![account] = JSON.stringify({
      schemaVersion: 1,
      mode: 'delete',
      active: activeJournal.active,
      retired: [activeJournal.active],
    });
    (pending['leverframe-deleted'] ??= {})[account] = 'v1:pending';
    saveState(fake.statePath, pending);
    const failedChunk = Object.keys(pending['leverframe-chunks']!)[0]!;
    saveControl(fake.controlPath, {
      failures: [{
        operation: 'delete',
        service: 'leverframe-chunks',
        account: failedChunk,
        remaining: 1,
        message: 'Secret Service disappeared during delete',
      }],
    });

    const failed = await operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'replacement-secret',
    });
    expect(failed).toEqual({ ok: false, error: 'Secret Service disappeared during delete' });
    expect(state(fake.statePath)['leverframe-deleted']?.[account]).toBe('v1:pending');
    expect(state(fake.statePath).leverframe?.[account]).toBeUndefined();

    await expect(operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'replacement-secret',
    })).resolves.toEqual({ ok: true, value: null });
    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: 'replacement-secret' });
  });

  it.each([
    {
      name: 'delete journal',
      failure: (account: string): FakeFailure => ({
        operation: 'set',
        service: 'leverframe-deleted',
        account,
        remaining: 1,
        message: 'failed after delete journal',
      }),
    },
    {
      name: 'pending guard',
      failure: (account: string): FakeFailure => ({
        operation: 'set',
        service: 'leverframe',
        account,
        remaining: 1,
        message: 'failed after pending guard',
      }),
    },
    {
      name: 'primary tombstone',
      failure: (account: string): FakeFailure => ({
        operation: 'delete',
        service: 'leverframe',
        account,
        remaining: 1,
        message: 'failed after primary tombstone',
      }),
    },
  ])('recovers replacement publication after interruption at $name', async ({ failure }) => {
    const fake = fakeKeyring();
    const account = 'provider:delete-boundary';
    await operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'previous-'.repeat(400),
    });
    saveControl(fake.controlPath, { failures: [failure(account)] });

    const interrupted = await operation(fake.moduleUrl, {
      operation: 'delete', service: 'leverframe', account,
    });
    expect(interrupted.ok).toBe(false);

    await expect(operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'replacement-secret',
    })).resolves.toEqual({ ok: true, value: null });
    await expect(operation(fake.moduleUrl, {
      operation: 'read', service: 'leverframe', account,
    })).resolves.toEqual({ ok: true, value: 'replacement-secret' });
  });

  it('does not bypass unrelated journal corruption during replacement', async () => {
    const fake = fakeKeyring();
    const account = 'provider:corrupt-replacement';
    saveState(fake.statePath, {
      leverframe: { [account]: 'kept-secret' },
      'leverframe-journal': { [account]: '{not json' },
    });

    const result = await operation(fake.moduleUrl, {
      operation: 'write', service: 'leverframe', account, value: 'replacement-secret',
    });
    expect(result).toEqual({ ok: false, error: 'integrity: keyring credential journal is corrupt' });
    expect(state(fake.statePath).leverframe?.[account]).toBe('kept-secret');
  });
});
