import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runIsolatedKeyringOperation } from '../src/credential-store.js';

type KeyringState = Record<string, Record<string, string>>;

const ACCOUNT = 'provider:test';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const RECORDING_KEYRING_SOURCE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const { statePath, logPath } = globalThis.recordingKeyringPaths;
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = state => writeFileSync(statePath, JSON.stringify(state));
const record = (operation, service, account) => appendFileSync(logPath, operation + ' ' + service + ' ' + account + '\\n');
export class Entry {
  constructor(service, account) { this.service = service; this.account = account; }
  getPassword() { return load()[this.service]?.[this.account] ?? null; }
  setPassword(value) { record('set', this.service, this.account); const state = load(); (state[this.service] ??= {})[this.account] = value; save(state); return true; }
  deletePassword() { record('delete', this.service, this.account); const state = load(); const had = Object.hasOwn(state[this.service] ?? {}, this.account); if (state[this.service]) delete state[this.service][this.account]; save(state); return had; }
}
export const findCredentials = service => Object.entries(load()[service] ?? {}).map(([account, password]) => ({ account, password }));
`;

function recordingKeyring(initial: KeyringState): { moduleUrl: string; mutations: () => string[] } {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-recording-keyring-'));
  const statePath = join(directory, 'state.json');
  const logPath = join(directory, 'mutations.log');
  const modulePath = join(directory, 'keyring.mjs');
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(logPath, '');
  const paths = `globalThis.recordingKeyringPaths = ${JSON.stringify({ statePath, logPath })};\n`;
  writeFileSync(modulePath, paths + RECORDING_KEYRING_SOURCE);
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    mutations: () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean),
  };
}

function run(moduleUrl: string, operation: 'peek' | 'read') {
  return runIsolatedKeyringOperation(
    { operation, service: 'leverframe', account: ACCOUNT },
    { moduleUrl, skipAvailabilityCheck: true, timeoutMs: 5_000 },
  );
}

function journal(value: object): Record<string, string> {
  return { [ACCOUNT]: JSON.stringify({ schemaVersion: 1, ...value }) };
}

function preparingWithStagedChunks(): KeyringState {
  const generation = randomUUID();
  const candidate = 'next-'.repeat(300);
  return {
    leverframe: { [ACCOUNT]: 'previous-dummy' },
    'leverframe-journal': journal({
      mode: 'preparing',
      previous: { kind: 'short', digest: sha256('previous-dummy') },
      candidate: { kind: 'chunks', marker: { version: 3, generation, count: 2, digest: sha256(candidate) } },
      retired: [],
    }),
    'leverframe-chunks': {
      [`${ACCOUNT}::chunk::${generation}::0`]: candidate.slice(0, 1200),
      [`${ACCOUNT}::chunk::${generation}::1`]: candidate.slice(1200),
    },
  };
}

function activeWithRetiredChunk(): KeyringState {
  const generation = randomUUID();
  return {
    leverframe: { [ACCOUNT]: 'active-dummy' },
    'leverframe-journal': journal({
      mode: 'active',
      active: { kind: 'short', digest: sha256('active-dummy') },
      retired: [{ kind: 'chunks', marker: { version: 3, generation, count: 1, digest: sha256('old') } }],
    }),
    'leverframe-chunks': { [`${ACCOUNT}::chunk::${generation}::0`]: 'old' },
  };
}

function preparingMatchingNeitherSide(): KeyringState {
  return {
    leverframe: { [ACCOUNT]: 'unexpected-dummy' },
    'leverframe-journal': journal({
      mode: 'preparing',
      previous: { kind: 'short', digest: sha256('previous-dummy') },
      candidate: { kind: 'short', digest: sha256('candidate-dummy') },
      retired: [],
    }),
  };
}

const LEGACY_VALUE = 'legacy-value-'.repeat(150);

function legacyChunked(): KeyringState {
  return {
    leverframe: {
      [ACCOUNT]: '__relay_chunked__:2',
      [`${ACCOUNT}::chunk::0`]: LEGACY_VALUE.slice(0, 1200),
      [`${ACCOUNT}::chunk::1`]: LEGACY_VALUE.slice(1200),
    },
  };
}

describe('keyring peek on journaled credentials', () => {
  it('returns the previous credential of a preparing journal and keeps the staged candidate chunks', async () => {
    const keyring = recordingKeyring(preparingWithStagedChunks());
    await expect(run(keyring.moduleUrl, 'peek')).resolves.toEqual({ ok: true, value: 'previous-dummy' });
    expect(keyring.mutations()).toEqual([]);
  });

  it('leaves retired chunks of an active journal in place', async () => {
    const keyring = recordingKeyring(activeWithRetiredChunk());
    await expect(run(keyring.moduleUrl, 'peek')).resolves.toEqual({ ok: true, value: 'active-dummy' });
    expect(keyring.mutations()).toEqual([]);
  });

  it('reports a completed deletion as deleted', async () => {
    const keyring = recordingKeyring({
      'leverframe-journal': journal({ mode: 'deleted', retired: [] }),
      'leverframe-deleted': { [ACCOUNT]: 'v1:deleted' },
    });
    await expect(run(keyring.moduleUrl, 'peek')).resolves.toEqual({ ok: true, value: null, deleted: true });
    expect(keyring.mutations()).toEqual([]);
  });

  it('fails with an integrity error when the published value matches neither side of a preparing journal', async () => {
    const keyring = recordingKeyring(preparingMatchingNeitherSide());
    const result = await run(keyring.moduleUrl, 'peek');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^integrity: published keyring state does not match its journal/);
    expect(keyring.mutations()).toEqual([]);
  });
});

describe('keyring peek on unjournaled credentials', () => {
  it('returns a raw credential that has no journal without writing one', async () => {
    const keyring = recordingKeyring({ leverframe: { [ACCOUNT]: 'raw-dummy' } });
    await expect(run(keyring.moduleUrl, 'peek')).resolves.toEqual({ ok: true, value: 'raw-dummy' });
    expect(keyring.mutations()).toEqual([]);
  });

  it('records the journal write a normal read performs on the same raw credential', async () => {
    const keyring = recordingKeyring({ leverframe: { [ACCOUNT]: 'raw-dummy' } });
    await expect(run(keyring.moduleUrl, 'read')).resolves.toEqual({ ok: true, value: 'raw-dummy' });
    expect(keyring.mutations()).toContain(`set leverframe-journal ${ACCOUNT}`);
  });

  it('reads a legacy chunked credential without migrating it to v3', async () => {
    const keyring = recordingKeyring(legacyChunked());
    await expect(run(keyring.moduleUrl, 'peek')).resolves.toEqual({ ok: true, value: LEGACY_VALUE });
    expect(keyring.mutations()).toEqual([]);
  });
});
