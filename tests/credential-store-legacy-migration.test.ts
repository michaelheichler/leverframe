import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals, readStoredCredential } from '../src/credential-store.js';
import { getCredentialFallbackPath } from '../src/credential-store.js';
import { getProvidersPath } from '../src/paths.js';

const originalHome = process.env['LEVERFRAME_HOME'];
let fixtureRoot: string | undefined;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function temporaryHome(): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'leverframe-legacy-credential-'));
  const home = join(fixtureRoot, 'home');
  process.env['LEVERFRAME_HOME'] = home;
  expect(inside(fixtureRoot, getCredentialFallbackPath())).toBe(true);
  expect(inside(fixtureRoot, getProvidersPath())).toBe(true);
  return home;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalHome;
  vi.restoreAllMocks();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

it('falls back from the primary keyring service and copies a legacy credential forward', async () => {
  temporaryHome();
  const operations: Array<{ operation: string; service: string }> = [];
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    operations.push({ operation: input.operation, service: input.service });
    if (input.operation === 'read' && input.service === 'leverframe') return { ok: true, value: null };
    if (input.operation === 'read' && input.service === 'clodex') return { ok: true, value: 'legacy-secret' };
    if (input.operation === 'write' && input.service === 'leverframe') return { ok: true, value: null };
    throw new Error(`Unexpected keyring operation: ${input.operation} ${input.service}`);
  });

  await expect(readStoredCredential('provider:openai')).resolves.toBe('legacy-secret');
  expect(operations).toEqual([
    { operation: 'read', service: 'leverframe' },
    { operation: 'read', service: 'clodex' },
    { operation: 'write', service: 'leverframe' },
  ]);
});

it('continues through legacy services after an empty first legacy lookup', async () => {
  temporaryHome();
  const operations: Array<{ operation: string; service: string }> = [];
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    operations.push({ operation: input.operation, service: input.service });
    if (input.operation === 'read' && input.service === 'relay-ai') return { ok: true, value: 'older-secret' };
    if (input.operation === 'write' && input.service === 'leverframe') return { ok: true, value: null };
    if (input.operation === 'read') return { ok: true, value: null };
    throw new Error(`Unexpected keyring operation: ${input.operation} ${input.service}`);
  });

  await expect(readStoredCredential('provider:openai')).resolves.toBe('older-secret');
  expect(operations).toEqual([
    { operation: 'read', service: 'leverframe' },
    { operation: 'read', service: 'clodex' },
    { operation: 'read', service: 'relay-ai' },
    { operation: 'write', service: 'leverframe' },
  ]);
});

it('continues to a legacy service when the primary keyring lookup fails', async () => {
  temporaryHome();
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' && input.service === 'leverframe') return { ok: false, error: 'primary unavailable' };
    if (input.operation === 'read' && input.service === 'clodex') return { ok: true, value: 'legacy-secret' };
    if (input.operation === 'write' && input.service === 'leverframe') return { ok: true, value: null };
    throw new Error(`Unexpected keyring operation: ${input.operation} ${input.service}`);
  });
  const diagnostics: string[] = [];

  await expect(readStoredCredential('provider:openai', message => diagnostics.push(message))).resolves.toBe('legacy-secret');
  expect(diagnostics).toContain('keyring error: primary unavailable');
});
