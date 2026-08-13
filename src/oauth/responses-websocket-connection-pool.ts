import type { ConnectionEntry } from './responses-websocket-types.js';

// A Claude session partition can have multiple valid conversation heads at
// once: rewinds/branches, hidden title-generation requests, and stop hooks can
// all share its model/effort/cache key. Retain each head and select by exact
// conversation prefix instead of letting the newest branch replace the rest.
// New heads live in a separately capped nursery LRU until their first reuse.
// established heads therefore never consume nursery capacity, and one-shot
// nursery traffic never consumes the established LRU's 32 reserved slots.
const connections = new Map<string, Set<ConnectionEntry>>();

const REQUEST_ENTRY_TRACKING_CAP = 256;
const entryByRequestId = new Map<string, ConnectionEntry>();

let nextConnectionDebugId = 1;

export function allocateConnectionDebugId(): number {
  return nextConnectionDebugId++;
}

/** Read the id the next connection will receive, without allocating it. */
export function peekNextConnectionDebugId(): number {
  return nextConnectionDebugId;
}

export function trackEntryForRequest(requestId: string, entry: ConnectionEntry): void {
  entryByRequestId.set(requestId, entry);
  entry.lastRequestId = requestId;
  while (entryByRequestId.size > REQUEST_ENTRY_TRACKING_CAP) {
    const oldestKey = entryByRequestId.keys().next().value;
    if (oldestKey === undefined) break;
    entryByRequestId.delete(oldestKey);
  }
}

/** Look up and detach the entry tracked for a request id, if it still owns it. */
export function releaseEntryForRequestId(requestId: string): ConnectionEntry | undefined {
  const entry = entryByRequestId.get(requestId);
  entryByRequestId.delete(requestId);
  if (!entry || entry.lastRequestId !== requestId) return undefined;
  entry.lastRequestId = undefined;
  return entry;
}

export function connectionEntries(key?: string): ConnectionEntry[] {
  return key ? [...(connections.get(key) ?? [])] : [...connections.values()].flatMap(entries => [...entries]);
}

export function connectionCount(): number {
  let count = 0;
  for (const entries of connections.values()) count += entries.size;
  return count;
}

export function connectionCountByGeneration(generation: ConnectionEntry['generation']): number {
  return connectionEntries().filter(entry => entry.generation === generation).length;
}

export function registerEntry(entry: ConnectionEntry): void {
  if (!entry.key) return;
  let entries = connections.get(entry.key);
  if (!entries) {
    entries = new Set();
    connections.set(entry.key, entries);
  }
  entries.add(entry);
}

function unregisterEntry(entry: ConnectionEntry): void {
  if (!entry.key) return;
  const entries = connections.get(entry.key);
  if (!entries) return;
  entries.delete(entry);
  if (entries.size === 0) connections.delete(entry.key);
}

export function debugKey(key: string | undefined): string {
  return key ? key.slice(0, 12) : 'none';
}

export function deleteEntry(entry: ConnectionEntry, closeSocket = true): void {
  entry.inFlight = false;
  entry.current = undefined;
  unregisterEntry(entry);
  if (entry.lastRequestId) {
    entryByRequestId.delete(entry.lastRequestId);
    entry.lastRequestId = undefined;
  }
  if (closeSocket) {
    try { entry.socket.close(); } catch { /* ignore */ }
  }
}

export function evictStaleCredentialConnections(
  credentialScopeKey: string | undefined,
  credentialFingerprint: string,
): Array<Record<string, unknown>> {
  if (!credentialScopeKey) return [];
  const evictions: Array<Record<string, unknown>> = [];
  for (const entry of connectionEntries()) {
    if (
      entry.inFlight
      || entry.credentialScopeKey !== credentialScopeKey
      || entry.credentialFingerprint === credentialFingerprint
    ) continue;
    evictions.push({
      connectionId: entry.debugId,
      partitionKey: entry.key,
      generation: entry.generation,
      reason: 'credential_rotated',
    });
    deleteEntry(entry);
  }
  return evictions;
}

export function cleanupExpiredConnections(now: number): Array<Record<string, unknown>> {
  const evictions: Array<Record<string, unknown>> = [];
  for (const entry of connectionEntries()) {
    if (entry.inFlight) continue;
    const idleTtlMs = entry.generation === 'nursery'
      ? entry.options.nurseryIdleTtlMs
      : entry.options.idleTtlMs;
    const ttlAgeMs = Math.max(0, now - entry.createdAt - entry.ttlPausedMs);
    if (ttlAgeMs >= entry.options.hardTtlMs || now - entry.lastUsedAt >= idleTtlMs) {
      entry.debug('evicting expired idle connection');
      evictions.push({
        connectionId: entry.debugId,
        partitionKey: entry.key,
        generation: entry.generation,
        reason: ttlAgeMs >= entry.options.hardTtlMs
          ? 'hard_ttl'
          : entry.generation === 'nursery' ? 'nursery_idle_ttl' : 'idle_ttl',
      });
      deleteEntry(entry);
    }
  }
  return evictions;
}

export function evictOldestIdleGeneration(
  generation: 'nursery' | 'established',
  maxConnections: number,
  reason: 'nursery_lru_cap' | 'established_lru_cap',
): Array<Record<string, unknown>> {
  const evictions: Array<Record<string, unknown>> = [];
  const idle = connectionEntries()
    .filter(entry => !entry.inFlight && entry.generation === generation)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  while (connectionCountByGeneration(generation) >= maxConnections && idle.length) {
    const oldest = idle.shift();
    if (oldest) {
      evictions.push({
        connectionId: oldest.debugId,
        partitionKey: oldest.key,
        generation: oldest.generation,
        reason,
      });
      deleteEntry(oldest);
    }
  }
  return evictions;
}

/** Test-only: drop all pool state without touching sockets or active requests. */
export function resetConnectionPoolState(): void {
  connections.clear();
  entryByRequestId.clear();
  nextConnectionDebugId = 1;
}
