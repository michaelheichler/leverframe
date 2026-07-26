// src/registry/io.ts: load/save providers.json with secure permissions

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ensureLegacyAppHomeMigrated, getAppHome, getProvidersPath } from '../paths.js';
import type { ProviderRegistry, RegistryProvider } from './types.js';
import { REGISTRY_SCHEMA_VERSION } from './types.js';
import { migrateOAuthOpenAiProvider } from './migrate.js';
import { isValidProviderId } from './validate.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function ensureSecureAppHome(): void {
  const home = getAppHome();
  mkdirSync(home, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(home, DIR_MODE);
  } catch {
    // best-effort on platforms that restrict chmod
  }
}

function writeSecureFile(path: string, content: string): void {
  ensureSecureAppHome();
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const fd = openSync(path, 'w', FILE_MODE);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // best-effort
  }
}

function parseProvider(raw: unknown): RegistryProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !isValidProviderId(p.id)) return null;
  if (typeof p.templateId !== 'string' || !p.templateId) return null;
  if (typeof p.name !== 'string' || !p.name) return null;
  if (typeof p.enabled !== 'boolean') return null;
  if (typeof p.authRef !== 'string' || !p.authRef) return null;
  if (typeof p.addedAt !== 'string' || !p.addedAt) return null;
  const api = p.api;
  if (!api || typeof api !== 'object') return null;

  const provider: RegistryProvider = {
    id: p.id,
    templateId: p.templateId,
    name: p.name,
    enabled: p.enabled,
    authRef: p.authRef,
    api: api as RegistryProvider['api'],
    addedAt: p.addedAt,
  };

  if (p.subscriptionFilter === 'free') {
    provider.subscriptionFilter = p.subscriptionFilter;
  }
  if (p.authType === 'api' || p.authType === 'oauth' || p.authType === 'none') {
    provider.authType = p.authType;
  }
  if (typeof p.refreshedAt === 'string') provider.refreshedAt = p.refreshedAt;
  if (p.modelsCache && typeof p.modelsCache === 'object') {
    const cache = p.modelsCache as { fetchedAt?: string; models?: unknown[] };
    if (typeof cache.fetchedAt === 'string' && Array.isArray(cache.models)) {
      provider.modelsCache = {
        fetchedAt: cache.fetchedAt,
        models: cache.models.filter(m => m && typeof m === 'object') as RegistryProvider['modelsCache'] extends infer C
          ? C extends { models: infer M } ? M : never
          : never,
      };
    }
  }
  return provider;
}

function parseRegistry(raw: unknown): ProviderRegistry {
  const empty: ProviderRegistry = { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const data = raw as Record<string, unknown>;
  const providers: RegistryProvider[] = [];
  if (Array.isArray(data.providers)) {
    for (const entry of data.providers) {
      const parsed = parseProvider(entry);
      if (parsed) providers.push(parsed);
    }
  }
  const registry: ProviderRegistry = {
    schemaVersion:
      typeof data.schemaVersion === 'number' ? data.schemaVersion : REGISTRY_SCHEMA_VERSION,
    providers,
  };
  if (typeof data.importedAt === 'string') registry.importedAt = data.importedAt;
  if (typeof data.pricingCacheAt === 'string') registry.pricingCacheAt = data.pricingCacheAt;
  return registry;
}

export function loadRegistry(path = getProvidersPath()): ProviderRegistry {
  ensureLegacyAppHomeMigrated();

  let rawText: string;
  try {
    rawText = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    quarantineCorruptRegistry(path, err);
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    quarantineCorruptRegistry(path, new Error('registry root is not a JSON object'));
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }

  try {
    const registry = parseRegistry(raw);
    const migrated = migrateOAuthOpenAiProvider(registry);
    if (migrated) {
      try {
        saveRegistry(registry, path);
      } catch {
        // Parsed data remains usable even when migration persistence fails.
      }
    }
    return registry;
  } catch {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
}

function quarantineCorruptRegistry(path: string, parseError: unknown): void {
  const reason = parseError instanceof Error ? parseError.message : String(parseError);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantined = `${path}.corrupt-${stamp}`;
  try {
    renameSync(path, quarantined);
  } catch (renameErr) {
    throw new Error(
      `leverframe: providers registry at ${path} is corrupt (${reason}) but could not be quarantined to ${quarantined}: `
        + `${renameErr instanceof Error ? renameErr.message : String(renameErr)}. `
        + 'The original file is left in place and later saves are refused to prevent overwrite.',
    );
  }
  console.warn(
    `leverframe: providers registry at ${path} is corrupt (${reason}). `
    + `It was quarantined to ${quarantined}. A fresh empty registry will be used; recover manually if needed.`,
  );
}

export function saveRegistry(registry: ProviderRegistry, path = getProvidersPath()): void {
  const payload = `${JSON.stringify(registry, null, 2)}\n`;
  const backup = `${path}.bak`;
  if (existsSync(path)) {
    assertExistingRegistryIsSafeToOverwrite(path);
    try {
      copyFileSync(path, backup);
    } catch {
      // backup is best-effort
    }
  }
  const tmp = `${path}.tmp`;
  writeSecureFile(tmp, payload);
  renameSync(tmp, path);
}

function assertExistingRegistryIsSafeToOverwrite(path: string): void {
  let rawText: string;
  try {
    rawText = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw err;
  }
  try {
    const raw = JSON.parse(rawText) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return;
  } catch {
    // The error below preserves the existing bytes and names the recovery path.
  }
  throw new Error(
    `leverframe: refusing to overwrite corrupt providers registry at ${path}; `
      + 'load it first so it can be quarantined, or move it aside manually.',
  );
}

export function emptyRegistry(): ProviderRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
}
