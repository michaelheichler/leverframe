// src/registry/io.ts: strict reads and durable, lock-fenced provider registry writes

import { existsSync, renameSync } from 'node:fs';
import { getAppHome, getProvidersPath, ensureLegacyAppHomeMigrated } from '../paths.js';
import {
  durableAtomicWrite,
  ensurePrivateDirectory,
  readFileStrict,
} from '../durable-io.js';
import type { ProviderRegistry, RegistryProvider } from './types.js';
import { REGISTRY_SCHEMA_VERSION } from './types.js';
import {
  assertRegistryWriteOwnership,
  getRegistryLockPath,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from './lock.js';
import { migrateOAuthOpenAiProvider } from './migrate.js';
import { isValidProviderId } from './validate.js';

const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;

export function ensureSecureAppHome(): void {
  ensurePrivateDirectory(getAppHome());
}

function parseProvider(raw: unknown): RegistryProvider | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !isValidProviderId(p.id)) return null;
  if (typeof p.templateId !== 'string' || !p.templateId) return null;
  if (typeof p.name !== 'string' || !p.name) return null;
  if (typeof p.enabled !== 'boolean') return null;
  if (typeof p.authRef !== 'string' || !p.authRef) return null;
  if (typeof p.addedAt !== 'string' || !p.addedAt) return null;
  if (!p.api || typeof p.api !== 'object' || Array.isArray(p.api)) return null;

  const provider: RegistryProvider = {
    id: p.id,
    templateId: p.templateId,
    name: p.name,
    enabled: p.enabled,
    authRef: p.authRef,
    api: p.api as RegistryProvider['api'],
    addedAt: p.addedAt,
  };
  if (p.subscriptionFilter === 'free') provider.subscriptionFilter = 'free';
  if (p.authType === 'api' || p.authType === 'oauth' || p.authType === 'none') {
    provider.authType = p.authType;
  }
  if (typeof p.refreshedAt === 'string') provider.refreshedAt = p.refreshedAt;
  if (p.modelsCache && typeof p.modelsCache === 'object' && !Array.isArray(p.modelsCache)) {
    const cache = p.modelsCache as { fetchedAt?: string; models?: unknown[] };
    if (typeof cache.fetchedAt === 'string' && Array.isArray(cache.models)) {
      provider.modelsCache = {
        fetchedAt: cache.fetchedAt,
        models: cache.models.filter(m => m && typeof m === 'object' && !Array.isArray(m)) as NonNullable<RegistryProvider['modelsCache']>['models'],
      };
    }
  }
  return provider;
}

function parseRegistry(raw: unknown): ProviderRegistry {
  const empty = emptyRegistry();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const data = raw as Record<string, unknown>;
  const registry: ProviderRegistry = {
    schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : REGISTRY_SCHEMA_VERSION,
    providers: Array.isArray(data.providers)
      ? data.providers.map(parseProvider).filter((p): p is RegistryProvider => p !== null)
      : [],
  };
  if (typeof data.importedAt === 'string') registry.importedAt = data.importedAt;
  if (typeof data.pricingCacheAt === 'string') registry.pricingCacheAt = data.pricingCacheAt;
  return registry;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function strictOptionalFields(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const provider = raw as Record<string, unknown>;
  if (hasOwn(provider, 'subscriptionFilter') && provider.subscriptionFilter !== 'free') return false;
  if (
    hasOwn(provider, 'authType')
    && provider.authType !== 'api'
    && provider.authType !== 'oauth'
    && provider.authType !== 'none'
  ) return false;
  if (hasOwn(provider, 'refreshedAt') && typeof provider.refreshedAt !== 'string') return false;
  if (hasOwn(provider, 'modelsCache')) {
    const cache = provider.modelsCache;
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return false;
    const fields = cache as Record<string, unknown>;
    if (typeof fields.fetchedAt !== 'string' || !Array.isArray(fields.models)) return false;
    if (fields.models.some(model => !model || typeof model !== 'object' || Array.isArray(model))) return false;
  }
  return true;
}

function parseRegistryStrict(raw: unknown): ProviderRegistry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Provider registry must be a JSON object.');
  }
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error('Provider registry has an unsupported schema version.');
  }
  if (!Array.isArray(data.providers)) throw new Error('Provider registry is missing its providers list.');
  const seen = new Set<string>();
  for (const entry of data.providers) {
    const provider = parseProvider(entry);
    if (!provider || !strictOptionalFields(entry)) {
      throw new Error('Provider registry contains an invalid provider entry.');
    }
    if (seen.has(provider.id)) throw new Error(`Provider registry contains duplicate id: ${provider.id}`);
    seen.add(provider.id);
  }
  return parseRegistry(raw);
}

function registryText(path: string): string {
  return readFileStrict(path, { maxBytes: MAX_REGISTRY_BYTES, description: 'Provider registry' });
}

function readStrict(path: string): ProviderRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(registryText(path));
  } catch (error) {
    throw new Error(`Provider registry is corrupt: ${path}`, { cause: error });
  }
  return parseRegistryStrict(parsed);
}

function quarantineCorruptRegistry(path: string, expectedText: string, reason: unknown): void {
  withRegistryWriteLockSync(() => {
    if (!existsSync(path)) return;
    const currentText = registryText(path);
    if (currentText !== expectedText) return;
    try {
      JSON.parse(currentText);
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantined = `${path}.corrupt-${stamp}`;
      assertRegistryWriteOwnership(path);
      renameSync(path, quarantined);
      console.warn(
        `leverframe: providers registry at ${path} is corrupt (${reason instanceof Error ? reason.message : String(reason)}). `
        + `It was quarantined to ${quarantined}; recover it manually if needed.`,
      );
    }
  }, { lockPath: getRegistryLockPath(path) });
}

export function loadRegistry(path = getProvidersPath()): ProviderRegistry {
  ensureLegacyAppHomeMigrated();
  if (!existsSync(path)) return emptyRegistry();

  let text: string;
  try {
    text = registryText(path);
  } catch {
    return emptyRegistry();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    quarantineCorruptRegistry(path, text, error);
    return emptyRegistry();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyRegistry();
  }

  const registry = parseRegistry(raw);
  if (migrateOAuthOpenAiProvider(registry)) {
    try {
      withRegistryWriteLockSync(() => {
        if (!existsSync(path)) return;
        const current = readStrict(path);
        if (migrateOAuthOpenAiProvider(current)) saveRegistryUnlocked(current, path);
      }, { lockPath: getRegistryLockPath(path) });
    } catch {
      // Parsed data remains usable when a best-effort migration cannot persist.
    }
  }
  return registry;
}

/** Strict read for deletion and other irreversible decisions. */
export function loadRegistryStrict(path = getProvidersPath()): ProviderRegistry {
  ensureLegacyAppHomeMigrated();
  if (!existsSync(path)) return emptyRegistry();
  const registry = readStrict(path);
  migrateOAuthOpenAiProvider(registry);
  return registry;
}

function saveRegistryUnlocked(registry: ProviderRegistry, path: string): void {
  assertRegistryWriteOwnership(path);
  parseRegistryStrict(registry);
  const payload = `${JSON.stringify(registry, null, 2)}\n`;
  durableAtomicWrite(path, payload, {
    fence: () => assertRegistryWriteOwnership(path),
  });
}

export function saveRegistry(registry: ProviderRegistry, path = getProvidersPath()): void {
  withRegistryWriteLockSync(
    () => saveRegistryUnlocked(registry, path),
    { lockPath: getRegistryLockPath(path) },
  );
}

/** Serialize a complete sync read-modify-write transaction across processes. */
export function updateRegistry<T>(
  update: (registry: ProviderRegistry) => T,
  path = getProvidersPath(),
): T {
  return withRegistryWriteLockSync(() => {
    const registry = loadRegistryStrict(path);
    const before = JSON.stringify(registry);
    const result = update(registry);
    if (JSON.stringify(registry) !== before) saveRegistryUnlocked(registry, path);
    return result;
  }, { lockPath: getRegistryLockPath(path) });
}

/** Serialize a complete async read-modify-write transaction across processes. */
export function updateRegistryAsync<T>(
  update: (registry: ProviderRegistry) => Promise<T> | T,
  path = getProvidersPath(),
): Promise<T> {
  return withRegistryWriteLock(async () => {
    const registry = loadRegistryStrict(path);
    const before = JSON.stringify(registry);
    const result = await update(registry);
    if (JSON.stringify(registry) !== before) saveRegistryUnlocked(registry, path);
    return result;
  }, { lockPath: getRegistryLockPath(path) });
}

export function emptyRegistry(): ProviderRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
}
