import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyringOperation, KeyringResult } from '../src/keyring-operations.js';
import { runIsolatedKeyringOperation } from '../src/keyring-operations.js';
import { openEvidenceStore } from '../src/context/evidence-runtime.js';
import { TRUSTED_METADATA_KEYRING_ACCOUNT, TRUSTED_METADATA_KEYRING_SERVICE } from '../src/context/workspace-digest-key.js';
import { runEvidenceCommand } from '../src/evidence-command.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';

const memoryKeyring = vi.hoisted(() => ({ entries: new Map<string, string>() }));

vi.mock('../src/keyring-operations.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/keyring-operations.js')>();
  return {
    ...actual,
    runIsolatedKeyringOperation: vi.fn(async (input: KeyringOperation): Promise<KeyringResult> => {
      const key = `${input.service}:${input.account}`;
      if (input.operation === 'read') return { ok: true, value: memoryKeyring.entries.get(key) ?? null };
      if (input.operation === 'write') {
        memoryKeyring.entries.set(key, input.value);
        return { ok: true, value: null };
      }
      return { ok: false, error: 'unexpected keyring operation' };
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  memoryKeyring.entries.clear();
});

describe('evidence retrieval interfaces', () => {
  it('requires the local API token and retrieves exact evidence for the matching session', async () => {
    const fixture = createRuntimeFixture();
    const server = await startServer({
      host: '127.0.0.1', port: 0, apiKey: 'unused', serverPassword: 'local-token',
      catalog: createGatewayModelCatalog([]),
    });
    try {
      const reference = await (await openEvidenceStore()).put('session-a', 'Original content stays exact.\n');
      vi.mocked(runIsolatedKeyringOperation).mockClear();
      const denied = await evidenceRequest(server.url, { sessionId: 'session-a', reference });
      expect(denied.status).toBe(401);
      expect(runIsolatedKeyringOperation).not.toHaveBeenCalled();
      const response = await evidenceRequest(server.url, { sessionId: 'session-a', reference }, 'local-token');
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ content: 'Original content stays exact.\n' });
      expect(runIsolatedKeyringOperation).toHaveBeenCalledTimes(1);
      expect(runIsolatedKeyringOperation).toHaveBeenCalledWith({
        operation: 'read', service: TRUSTED_METADATA_KEYRING_SERVICE, account: TRUSTED_METADATA_KEYRING_ACCOUNT,
      });
    } finally {
      await server.close();
      fixture.close();
    }
  });

  it('prints exact source content through the evidence command', async () => {
    const fixture = createRuntimeFixture();
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    });
    try {
      const reference = await (await openEvidenceStore()).put('session-a', 'Exact terminal evidence.');
      vi.mocked(runIsolatedKeyringOperation).mockClear();
      await expect(runEvidenceCommand(['get', 'session-a', reference])).resolves.toBe(0);
      expect(output).toBe('Exact terminal evidence.');
      expect(runIsolatedKeyringOperation).toHaveBeenCalledTimes(1);
      expect(runIsolatedKeyringOperation).toHaveBeenCalledWith({
        operation: 'read', service: TRUSTED_METADATA_KEYRING_SERVICE, account: TRUSTED_METADATA_KEYRING_ACCOUNT,
      });
    } finally {
      write.mockRestore();
      fixture.close();
    }
  });

  it('returns failure instead of source content when the command session does not match', async () => {
    const fixture = createRuntimeFixture();
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    });
    try {
      const reference = await (await openEvidenceStore()).put('session-a', 'Private source.');
      await expect(runEvidenceCommand(['get', 'session-b', reference])).resolves.toBe(1);
      expect(output).toBe('');
    } finally {
      write.mockRestore();
      fixture.close();
    }
  });
});

function createRuntimeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-evidence-runtime-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  return { home, close: () => rmSync(home, { recursive: true, force: true }) };
}

async function evidenceRequest(url: string, body: { sessionId: string; reference: string }, token?: string) {
  return fetch(`${url}/v1/leverframe/evidence`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
