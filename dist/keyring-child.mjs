const { createHash, randomUUID } = await import('node:crypto');
const CHUNK_PREFIX = '__relay_chunked__:';
const DELETE_TOMBSTONE_PREFIX = '__leverframe_delete__:';
const INVENTORY_PREFIX = '__leverframe_inventory__:';
const CHUNK_SERVICE = 'leverframe-chunks';
const JOURNAL_SERVICE = 'leverframe-journal';
const DELETED_SERVICE = 'leverframe-deleted';
const CHUNK_SIZE = 1200;
const MAX_CHUNKS = 128;
const MAX_JOURNAL_CHUNKS = 6;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const integrity = message => new Error('integrity: ' + message);
const digest = value => createHash('sha256').update(value).digest('hex');

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const keyring = await import(input.moduleUrl);
  const { Entry } = keyring;

  const raw = (service, account) => {
    const value = new Entry(service, account).getPassword();
    return value === undefined ? null : value;
  };
  const set = (service, account, value) => {
    new Entry(service, account).setPassword(value);
    if (raw(service, account) !== value) throw integrity('keyring write verification failed');
  };
  const remove = (service, account) => {
    const entry = new Entry(service, account);
    const existing = raw(service, account);
    if (existing === null) {
      entry.deletePassword();
      return raw(service, account) === null;
    }
    const tombstone = existing.startsWith(DELETE_TOMBSTONE_PREFIX)
      ? existing
      : DELETE_TOMBSTONE_PREFIX + randomUUID();
    if (existing !== tombstone) set(service, account, tombstone);
    if (!entry.deletePassword()) return false;
    return raw(service, account) === null;
  };
  const chunkAccount = (account, marker, index) => marker.generation
    ? account + '::chunk::' + marker.generation + '::' + index
    : account + '::chunk::' + index;
  const chunkService = marker => marker.version === 3 ? CHUNK_SERVICE : input.service;
  const parseMarker = value => {
    if (!value?.startsWith(CHUNK_PREFIX)) return null;
    const encoded = value.slice(CHUNK_PREFIX.length);
    const v3 = /^v3:([^:]+):(\d+):([0-9a-f]{64})$/.exec(encoded);
    const v2 = /^v2:([^:]+):(\d+)$/.exec(encoded);
    const legacy = /^(\d+)$/.exec(encoded);
    const countText = v3?.[2] ?? v2?.[2] ?? legacy?.[1];
    const count = Number(countText);
    const generation = v3?.[1] ?? v2?.[1];
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CHUNKS) {
      throw integrity('keyring credential has an invalid chunk marker');
    }
    if (generation !== undefined && !GENERATION.test(generation)) {
      throw integrity('keyring credential has an invalid chunk generation');
    }
    return {
      version: v3 ? 3 : v2 ? 2 : 1,
      count,
      ...(generation ? { generation } : {}),
      ...(v3 ? { digest: v3[3] } : {}),
    };
  };
  const markerValue = marker => marker.version === 3
    ? CHUNK_PREFIX + 'v3:' + marker.generation + ':' + marker.count + ':' + marker.digest
    : marker.version === 2
      ? CHUNK_PREFIX + 'v2:' + marker.generation + ':' + marker.count
      : CHUNK_PREFIX + marker.count;
  const markerKey = marker => marker.version + ':' + (marker.generation ?? 'legacy') + ':' + marker.count + ':' + (marker.digest ?? '');
  const readMarker = (account, marker) => {
    let value = '';
    for (let index = 0; index < marker.count; index++) {
      const part = raw(chunkService(marker), chunkAccount(account, marker, index));
      if (part === null || part.startsWith(DELETE_TOMBSTONE_PREFIX)) {
        throw integrity('keyring credential chunk ' + (index + 1) + ' of ' + marker.count + ' is missing');
      }
      value += part;
    }
    if (marker.digest && digest(value) !== marker.digest) {
      throw integrity('keyring credential chunk digest does not match');
    }
    return value;
  };
  const descriptorFor = value => {
    if (value === null) return null;
    const marker = parseMarker(value);
    if (marker) {
      readMarker(input.account, marker);
      return { kind: 'chunks', marker };
    }
    if (value.startsWith(DELETE_TOMBSTONE_PREFIX)) throw integrity('keyring credential is tombstoned');
    return { kind: 'short', digest: digest(value) };
  };
  const descriptorMatches = (descriptor, value) => {
    if (descriptor === null) return value === null;
    if (value === null) return false;
    if (descriptor.kind === 'short') return !value.startsWith(CHUNK_PREFIX) && digest(value) === descriptor.digest;
    try {
      const marker = parseMarker(value);
      return marker !== null && markerKey(marker) === markerKey(descriptor.marker);
    } catch { return false; }
  };
  const parseDescriptor = value => {
    if (value === null) return null;
    if (!value || typeof value !== 'object') throw integrity('keyring journal descriptor is invalid');
    if (value.kind === 'short' && typeof value.digest === 'string' && DIGEST.test(value.digest)) {
      return { kind: 'short', digest: value.digest };
    }
    if (value.kind === 'chunks') {
      const marker = value.marker;
      const validCount = Number.isSafeInteger(marker?.count) && marker.count >= 1 && marker.count <= MAX_CHUNKS;
      const validLegacy = marker?.version === 1 && marker.generation === undefined && marker.digest === undefined;
      const validV2 = marker?.version === 2 && GENERATION.test(marker.generation) && marker.digest === undefined;
      const validV3 = marker?.version === 3 && GENERATION.test(marker.generation) && DIGEST.test(marker.digest);
      if (!validCount || (!validLegacy && !validV2 && !validV3)) {
        throw integrity('keyring journal marker is invalid');
      }
      return {
        kind: 'chunks',
        marker: {
          version: marker.version,
          count: marker.count,
          ...(marker.generation ? { generation: marker.generation } : {}),
          ...(marker.digest ? { digest: marker.digest } : {}),
        },
      };
    }
    throw integrity('keyring journal descriptor is invalid');
  };
  const readJournal = () => {
    const value = raw(JOURNAL_SERVICE, input.account);
    if (value === null) return null;
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw integrity('keyring credential journal is corrupt'); }
    if (!parsed || parsed.schemaVersion !== 1 || !['preparing', 'active', 'delete', 'deleted'].includes(parsed.mode)) {
      throw integrity('keyring credential journal has an invalid schema');
    }
    const retired = Array.isArray(parsed.retired) ? parsed.retired.map(parseDescriptor) : [];
    if (retired.length > MAX_JOURNAL_CHUNKS || retired.some(value => value?.kind !== 'chunks')) {
      throw integrity('keyring credential journal has an invalid inventory');
    }
    return {
      schemaVersion: 1,
      mode: parsed.mode,
      previous: parseDescriptor(parsed.previous ?? null),
      candidate: parseDescriptor(parsed.candidate ?? null),
      active: parseDescriptor(parsed.active ?? null),
      retired,
    };
  };
  const writeJournal = journal => {
    const encoded = JSON.stringify(journal);
    if (encoded.length > CHUNK_SIZE) throw integrity('keyring credential journal exceeds its bounded entry size');
    set(JOURNAL_SERVICE, input.account, encoded);
  };
  const deleteDescriptor = descriptor => {
    if (!descriptor || descriptor.kind !== 'chunks') return true;
    let ok = true;
    for (let index = 0; index < descriptor.marker.count; index++) {
      if (!remove(chunkService(descriptor.marker), chunkAccount(input.account, descriptor.marker, index))) ok = false;
    }
    return ok;
  };
  const inventory = service => {
    if (typeof keyring.findCredentials !== 'function') return null;
    const found = keyring.findCredentials(service);
    if (!Array.isArray(found)) throw integrity('keyring credential inventory is unavailable');
    return found.filter(item => item && typeof item.account === 'string' && typeof item.password === 'string');
  };
  const inventoryChunks = () => {
    if (typeof keyring.findCredentials !== 'function') {
      throw integrity('keyring credential inventory is unavailable');
    }
    const result = [];
    for (const service of [input.service, CHUNK_SERVICE]) {
      const sentinelGeneration = randomUUID();
      const sentinelAccount = input.account + '::chunk::' + sentinelGeneration + '::0';
      const sentinelValue = INVENTORY_PREFIX + sentinelGeneration;
      set(service, sentinelAccount, sentinelValue);
      let sentinelCleanupFailed = false;
      try {
        const entries = inventory(service);
        if (!entries?.some(item => item.account === sentinelAccount && item.password === sentinelValue)) {
          throw integrity('keyring credential inventory could not be verified');
        }
        for (const item of entries) {
          if (!item.account.startsWith(input.account + '::chunk::') || item.account === sentinelAccount) continue;
          if (item.password.startsWith(INVENTORY_PREFIX)) {
            remove(service, item.account);
            continue;
          }
          result.push({ service, account: item.account });
        }
      } finally {
        if (!remove(service, sentinelAccount)) sentinelCleanupFailed = true;
      }
      if (sentinelCleanupFailed) throw integrity('keyring inventory sentinel could not be removed');
    }
    return result;
  };
  const activeValue = () => raw(input.service, input.account);
  const finalJournal = descriptor => ({ schemaVersion: 1, mode: 'active', active: descriptor, retired: [] });
  const readGuard = () => {
    const guard = raw(DELETED_SERVICE, input.account);
    if (guard === null || guard === 'v1:pending' || guard === 'v1:deleted') return guard;
    throw integrity('keyring deletion guard is invalid');
  };

  const completeDelete = journal => {
    const descriptors = journal?.mode === 'delete' ? journal.retired : [];
    set(DELETED_SERVICE, input.account, 'v1:pending');
    const current = activeValue();
    if (current !== null) {
      if (!current.startsWith(DELETE_TOMBSTONE_PREFIX)) {
        set(input.service, input.account, DELETE_TOMBSTONE_PREFIX + randomUUID());
      }
      if (!remove(input.service, input.account)) {
        throw integrity('keyring credential deletion could not be verified');
      }
    }
    for (const descriptor of descriptors) {
      if (!deleteDescriptor(descriptor)) {
        throw integrity('keyring credential chunk deletion could not be verified');
      }
    }
    for (const item of inventoryChunks()) {
      if (!remove(item.service, item.account)) {
        throw integrity('keyring credential inventory deletion could not be verified');
      }
    }
    if (activeValue() !== null) throw integrity('keyring credential deletion could not be verified');
    writeJournal({ schemaVersion: 1, mode: 'deleted', retired: [] });
    set(DELETED_SERVICE, input.account, 'v1:deleted');
    return true;
  };

  const reconcile = () => {
    const guard = readGuard();
    const journal = readJournal();
    let current = activeValue();
    if (journal?.mode === 'deleted') {
      if (guard === 'v1:deleted') return { deleted: true, active: null };
      if (guard === null || guard === 'v1:pending') return { deleting: true, journal };
    }
    if (journal?.mode === 'delete') {
      if (guard === 'v1:deleted') throw integrity('keyring deletion metadata is inconsistent');
      return { deleting: true, journal };
    }
    if (guard !== null) throw integrity('keyring deletion metadata is inconsistent');
    if (journal?.mode === 'preparing') {
      if (descriptorMatches(journal.candidate, current)) {
        const retired = [journal.previous, ...journal.retired].filter(Boolean);
        writeJournal({ schemaVersion: 1, mode: 'active', active: journal.candidate, retired });
        for (const descriptor of retired) {
          if (!deleteDescriptor(descriptor)) throw integrity('keyring credential cleanup is incomplete');
        }
        writeJournal(finalJournal(journal.candidate));
        return { active: journal.candidate };
      }
      if (descriptorMatches(journal.previous, current)) {
        if (!deleteDescriptor(journal.candidate)) throw integrity('keyring credential cleanup is incomplete');
        writeJournal(finalJournal(journal.previous));
        return { active: journal.previous };
      }
      throw integrity('published keyring state does not match its journal');
    }
    if (journal?.mode === 'active') {
      if (!descriptorMatches(journal.active, current)) {
        if (current === null) {
          for (const descriptor of journal.retired) {
            if (descriptor && !deleteDescriptor(descriptor)) {
              throw integrity('keyring credential cleanup is incomplete');
            }
          }
          remove(JOURNAL_SERVICE, input.account);
          return { active: null };
        }
        const adopted = descriptorFor(current);
        const adoptedKey = adopted.kind === 'chunks' ? markerKey(adopted.marker) : null;
        const stale = [journal.active, ...journal.retired]
          .filter(item => item?.kind === 'chunks' && markerKey(item.marker) !== adoptedKey)
          .slice(0, MAX_JOURNAL_CHUNKS);
        writeJournal({ schemaVersion: 1, mode: 'active', active: adopted, retired: stale });
        for (const descriptor of stale) {
          if (!deleteDescriptor(descriptor)) throw integrity('keyring credential cleanup is incomplete');
        }
        writeJournal(finalJournal(adopted));
        return { active: adopted, adopted: true };
      }
      if (journal.active?.kind === 'chunks') readMarker(input.account, journal.active.marker);
      for (const descriptor of journal.retired) {
        if (!deleteDescriptor(descriptor)) throw integrity('keyring credential cleanup is incomplete');
      }
      if (journal.retired.length) writeJournal(finalJournal(journal.active));
      return { active: journal.active };
    }
    if (current === null) return { active: null };
    const adopted = descriptorFor(current);
    writeJournal(finalJournal(adopted));
    return { active: adopted, adopted: true };
  };

  const publish = value => {
    const state = reconcile();
    if (state.deleting) completeDelete(state.journal);
    if (!remove(DELETED_SERVICE, input.account)) {
      throw integrity('keyring deletion guard could not be cleared');
    }
    const previousValue = activeValue();
    const previous = descriptorFor(previousValue);
    const retired = previous?.kind === 'chunks' ? [previous] : [];
    let candidate;
    let publishedValue;
    if (value.length <= CHUNK_SIZE) {
      candidate = { kind: 'short', digest: digest(value) };
      publishedValue = value;
    } else {
      const parts = [];
      for (let start = 0; start < value.length;) {
        let end = Math.min(start + CHUNK_SIZE, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end -= 1;
        parts.push(value.slice(start, end));
        start = end;
      }
      if (parts.length > MAX_CHUNKS) throw new Error('keyring credential exceeds the supported chunk count');
      const marker = { version: 3, generation: randomUUID(), count: parts.length, digest: digest(value) };
      candidate = { kind: 'chunks', marker };
      publishedValue = markerValue(marker);
      writeJournal({ schemaVersion: 1, mode: 'preparing', previous, candidate, retired });
      for (const [index, part] of parts.entries()) set(CHUNK_SERVICE, chunkAccount(input.account, marker, index), part);
      if (readMarker(input.account, marker) !== value) throw new Error('keyring credential generation verification failed');
    }
    if (candidate.kind === 'short') {
      writeJournal({ schemaVersion: 1, mode: 'preparing', previous, candidate, retired });
    }
    set(input.service, input.account, publishedValue);
    if (candidate.kind === 'chunks' && readMarker(input.account, candidate.marker) !== value) {
      throw new Error('published keyring credential verification failed');
    }
    writeJournal({ schemaVersion: 1, mode: 'active', active: candidate, retired });
    for (const descriptor of retired) {
      if (descriptorMatches(candidate, markerValue(descriptor.marker))) continue;
      if (!deleteDescriptor(descriptor)) throw integrity('keyring credential cleanup is pending');
    }
    writeJournal(finalJournal(candidate));
    return true;
  };

  const readCredential = () => {
    const state = reconcile();
    if (state.deleted || state.deleting) return null;
    const value = activeValue();
    if (value === null) return null;
    const marker = parseMarker(value);
    if (!marker) return value;
    const combined = readMarker(input.account, marker);
    if (marker.version < 3) publish(combined);
    return combined;
  };

  const deleteCredential = () => {
    const guard = readGuard();
    let journal = readJournal();
    if (journal?.mode === 'deleted' && guard === 'v1:deleted') return true;
    if (guard === 'v1:deleted' && journal?.mode !== 'deleted') {
      throw integrity('keyring deletion metadata is inconsistent');
    }
    if (guard === 'v1:pending' && journal?.mode !== 'delete' && journal?.mode !== 'deleted') {
      throw integrity('keyring deletion metadata is inconsistent');
    }
    const current = activeValue();
    if (journal?.mode === 'deleted') return completeDelete(journal);
    if (journal?.mode === 'delete') {
      return completeDelete(journal);
    }
    const descriptors = [];
    const descriptor = descriptorFor(current);
    if (descriptor?.kind === 'chunks') descriptors.push(descriptor);
    if (journal?.active?.kind === 'chunks') descriptors.push(journal.active);
    descriptors.push(...(journal?.retired ?? []));
    const unique = new Map(descriptors.map(value => [markerKey(value.marker), value]));
    const retired = [...unique.values()];
    journal = { schemaVersion: 1, mode: 'delete', active: descriptor, retired };
    writeJournal(journal);
    return completeDelete(journal);
  };

  const repairCredential = () => {
    try { return readCredential(); }
    catch {
      remove(JOURNAL_SERVICE, input.account);
      try { return readCredential(); }
      catch {
        remove(input.service, input.account);
        remove(DELETED_SERVICE, input.account);
        remove(JOURNAL_SERVICE, input.account);
        try { for (const item of inventoryChunks()) remove(item.service, item.account); } catch {}
        return null;
      }
    }
  };

  let value = null;
  if (input.operation === 'read') value = readCredential();
  else if (input.operation === 'write') publish(input.value);
  else if (input.operation === 'delete') deleteCredential();
  else if (input.operation === 'repair') value = repairCredential();
  else throw new Error('Unsupported keyring operation');
  const deleted = input.operation === 'read' && readGuard() !== null;
  process.stdout.write(JSON.stringify({ ok: true, value, ...(deleted ? { deleted: true } : {}) }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}