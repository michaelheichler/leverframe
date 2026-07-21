// src/registry/models-dev.ts: models.dev capability cache (bundled + optional user refresh)

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import bundledCache from '../data/models-dev-cache.json';
import { getAppHome } from '../paths.js';
import { normalizeModelIdCandidates } from './pricing.js';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 15_000;
const FILE_MODE = 0o600;
/** Skip the models.dev refresh when the on-disk cache is younger than this. */
const MODELS_DEV_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelsDevModalities {
  input?: string[];
  output?: string[];
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  tool_call?: boolean;
  chat?: boolean;
  interactions?: boolean;
  reasoning?: boolean;
  interleaved?: { field?: string };
  modalities?: ModelsDevModalities;
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCacheFile = Record<string, ModelsDevProvider>;

export interface ModelsDevCacheMeta {
  schema_version?: string;
  fetched_at?: string;
  source?: string;
  provider_count?: number;
}

const META_KEY = '_relay_meta';

let memoryCache: ModelsDevCacheFile | null = null;
let memoryCachePath: string | null = null;
let memoryCacheMtime = 0;

/** Registry / OpenCode provider id → models.dev top-level key */
export const REGISTRY_TO_MODELS_DEV: Record<string, string> = {
  google: 'google',
  openai: 'openai',
  groq: 'groq',
  mistral: 'mistral',
  togetherai: 'together',
  cerebras: 'cerebras',
  deepinfra: 'deepinfra',
  xai: 'xai',
  'xai-oauth': 'xai',
  perplexity: 'perplexity',
  cohere: 'cohere',
  alibaba: 'alibaba',
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  nvidia: 'nvidia',
  venice: 'openrouter',
};

export function readModelsDevCacheMeta(
  cache: ModelsDevCacheFile,
): ModelsDevCacheMeta | null {
  const raw = cache[META_KEY] as unknown as ModelsDevCacheMeta | undefined;
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

export function stripModelsDevCacheMeta(cache: ModelsDevCacheFile): ModelsDevCacheFile {
  const { [META_KEY]: _meta, ...providers } = cache;
  return providers;
}

export function loadBundledModelsDevCache(): ModelsDevCacheFile {
  return bundledCache as unknown as ModelsDevCacheFile;
}

export function invalidateModelsDevCache(): void {
  memoryCache = null;
  memoryCachePath = null;
  memoryCacheMtime = 0;
}

function readModelsDevFile(path: string): ModelsDevCacheFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ModelsDevCacheFile;
  } catch {
    return null;
  }
}

function mkdirSafe(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // ignore
  }
}

function attachModelsDevCacheMeta(
  providers: Record<string, ModelsDevProvider>,
): ModelsDevCacheFile {
  const providerCount = Object.keys(providers).filter(k => !k.startsWith('_')).length;
  return {
    [META_KEY]: {
      schema_version: '1',
      fetched_at: new Date().toISOString(),
      source: MODELS_DEV_API_URL,
      provider_count: providerCount,
    },
    ...providers,
  } as ModelsDevCacheFile;
}

function writeModelsDevCache(path: string, data: ModelsDevCacheFile): void {
  mkdirSafe(dirname(path));
  writeFileSync(path, `${JSON.stringify(data)}\n`, { mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // best-effort
  }
  invalidateModelsDevCache();
}

export function getUserModelsDevCachePath(): string {
  return join(getAppHome(), 'models-dev-cache.json');
}

function rememberModelsDevCache(path: string, data: ModelsDevCacheFile): ModelsDevCacheFile {
  memoryCache = data;
  memoryCachePath = path;
  try {
    memoryCacheMtime = statSync(path).mtimeMs;
  } catch {
    memoryCacheMtime = 0;
  }
  return data;
}

export function loadModelsDevCache(): ModelsDevCacheFile {
  const userPath = getUserModelsDevCachePath();
  if (existsSync(userPath)) {
    try {
      const mtime = statSync(userPath).mtimeMs;
      if (memoryCache && memoryCachePath === userPath && memoryCacheMtime === mtime) {
        return memoryCache;
      }
      const data = readModelsDevFile(userPath);
      if (data) return rememberModelsDevCache(userPath, data);
    } catch {
      // fall through to bundled
    }
  }

  if (memoryCache && memoryCachePath === 'bundled') return memoryCache;
  return rememberModelsDevCache('bundled', loadBundledModelsDevCache());
}

/**
 * Read ONLY the user cache file (no bundled fallback). Returns null when the
 * file is missing or unreadable. Used by refreshModelsDevCacheAsync so the
 * TTL-skip path never treats the bundled snapshot as a valid user cache.
 */
function readUserModelsDevCache(): ModelsDevCacheFile | null {
  return readModelsDevFile(getUserModelsDevCachePath());
}

export function isModelsDevCacheFresh(
  cache: ModelsDevCacheFile | null,
  now: number = Date.now(),
): boolean {
  if (!cache) return false;
  const meta = readModelsDevCacheMeta(cache);
  const fetchedAt = meta?.fetched_at ? Date.parse(meta.fetched_at) : NaN;
  if (!Number.isFinite(fetchedAt)) return false;
  // A fetched_at in the future (clock skew or tampering) is not fresh.
  if (fetchedAt > now) return false;
  return now - fetchedAt < MODELS_DEV_REFRESH_TTL_MS;
}

export async function fetchModelsDevCache(): Promise<ModelsDevCacheFile | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, ModelsDevProvider>;
    if (!data || typeof data !== 'object') return null;
    const withMeta = attachModelsDevCacheMeta(data);
    writeModelsDevCache(getUserModelsDevCachePath(), withMeta);
    return withMeta;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveModelsDevSlug(providerId: string): string {
  return REGISTRY_TO_MODELS_DEV[providerId] ?? providerId;
}

type RefreshModelsDevOptions = { force?: boolean; onComplete?: (updated: boolean) => void | Promise<void> };

/**
 * Fetch the latest models.dev catalog in the background; falls back to the
 * bundled snapshot offline. Skips the network fetch only when a valid USER
 * cache (not the bundled fallback) is younger than MODELS_DEV_REFRESH_TTL_MS.
 * Pass `force: true` to bypass the TTL.
 *
 * Accepts either the legacy callback form
 * `refreshModelsDevCacheAsync(onComplete?)` or the options object
 * `{ force, onComplete }`. The callback runs from a background promise. A
 * callback that throws synchronously OR returns a rejected promise is
 * swallowed so neither path creates an unhandled rejection.
 */
export function refreshModelsDevCacheAsync(
  optionsOrCallback: RefreshModelsDevOptions | ((updated: boolean) => void | Promise<void>) = {},
): void {
  const opts: RefreshModelsDevOptions = typeof optionsOrCallback === 'function'
    ? { onComplete: optionsOrCallback }
    : optionsOrCallback;
  const { force = false, onComplete } = opts;
  const safeOnComplete = (updated: boolean): void => {
    if (!onComplete) return;
    let result: unknown;
    try {
      result = onComplete(updated);
    } catch {
      return;
    }
    if (result && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
      Promise.resolve(result as Promise<unknown>).catch(() => {
        // async callback rejection: swallow so the background refresh stays unhandled-rejection-free
      });
    }
  };
  void (async () => {
    try {
      if (!force) {
        const userCache = readUserModelsDevCache();
        if (userCache && isModelsDevCacheFresh(userCache)) {
          safeOnComplete(false);
          return;
        }
      }
      const updated = (await fetchModelsDevCache()) !== null;
      safeOnComplete(updated);
    } catch {
      safeOnComplete(false);
    }
  })();
}

export function findModelsDevModel(
  providerId: string,
  modelId: string,
  cache: ModelsDevCacheFile = loadModelsDevCache(),
): ModelsDevModel | null {
  const slug = resolveModelsDevSlug(providerId);
  const models = stripModelsDevCacheMeta(cache)[slug]?.models;
  if (!models) return null;

  for (const candidate of normalizeModelIdCandidates(modelId)) {
    const entry = models[candidate];
    if (entry) return entry;
  }
  return null;
}

/** Conservative auto-hide rules: only when models.dev row exists and fields are explicit. */
export function shouldHideByModelsDevCapabilities(entry: ModelsDevModel): boolean {
  const output = entry.modalities?.output;
  if (output && output.length > 0 && !output.includes('text')) return true;
  if (entry.tool_call === false) return true;
  if (entry.interactions === true && entry.chat === false) return true;
  return false;
}
