#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const marker = '[leverframe openai cache] ';
const usage = 'Usage: leverframe-cache-report --input <log> [--input <log>] [--since <UTC time>] [--until <UTC time>] [--support]';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const code = value => typeof value === 'string' && /^[a-z_]{1,48}$/.test(value) ? value : null;
const tag = value => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value : null;
const statuses = new Set(['completed', 'failed', 'incomplete', 'transport-error']);
const changes = new Set(['none', 'settings', 'tools', 'instructions', 'input', 'unknown']);
const baselines = new Set(['cold', 'recent', 'expired', 'no-session-key']);

function readRecord(line) {
  const offset = line.indexOf(marker);
  if (offset < 0) return undefined;
  if (line.length - offset > 8192) return null;
  try {
    const row = JSON.parse(line.slice(offset + marker.length));
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const start = count(row.startedAtMs);
    const elapsed = count(row.elapsedMs);
    const sequence = count(row.requestSequence);
    const end = start === null || elapsed === null ? null : start + elapsed;
    const scope = tag(row.scopeTag);
    if (!scope || sequence === null || sequence === 0 || end === null || end > 8.64e15) return null;
    const section = changes.has(row.prefix?.firstChangedSection) ? row.prefix.firstChangedSection : 'unknown';
    const shared = count(row.prefix?.sharedInputItems);
    const previous = count(row.prefix?.previousInputItems);
    return {
      start, end, sequence, scope, session: tag(row.sessionTag),
      model: typeof row.model === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(row.model) ? row.model : null,
      effort: code(row.effort),
      toolMode: ['standard', 'append-only'].includes(row.toolMode) ? row.toolMode : null,
      comparisonMode: ['local-only', 'openai'].includes(row.comparisonMode) ? row.comparisonMode : null,
      status: statuses.has(row.status) ? row.status : row.status === undefined ? 'completed' : 'unknown',
      baseline: baselines.has(row.baselineState) ? row.baselineState : 'unknown',
      baselineAgeMs: count(row.baselineAgeMs),
      section: section === 'none' && (shared === null || shared !== previous) ? 'unknown' : section,
      shared, previous, input: count(row.inputTokens), cached: count(row.cachedTokens),
      written: count(row.cacheWriteTokens), output: count(row.outputTokens),
      outcome: code(row.outcome), reason: code(row.reason),
      upstream: typeof row.upstreamRequestId === 'string' && /^req_[a-zA-Z0-9_-]{1,192}$/.test(row.upstreamRequestId)
        ? row.upstreamRequestId : null,
    };
  } catch {
    return null;
  }
}

function group(rows, select) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(select(row));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function markOverlap(rows) {
  for (const peers of group(rows.filter(row => row.session && row.end > row.start), row => [row.model ?? row.scope, row.session])) {
    peers.sort((a, b) => a.start - b.start || a.sequence - b.sequence);
    let latestEnd = -Infinity;
    for (const [index, row] of peers.entries()) {
      row.overlap = row.start < latestEnd || (peers[index + 1]?.start ?? Infinity) < row.end;
      latestEnd = Math.max(latestEnd, row.end);
    }
  }
}

function tokens(rows, select) {
  let known = 0;
  let total = 0;
  for (const row of rows) {
    const value = select(row);
    if (value === null) continue;
    total += value;
    known++;
  }
  return { reported: known, total: known > 0 ? total : null };
}

function sample(row) {
  return {
    startedAt: new Date(row.start).toISOString(),
    requestSequence: row.sequence,
    baselineAgeMs: row.baselineAgeMs,
    observedOverlap: row.overlap ?? null,
    inputTokens: row.input,
    cacheReadTokens: row.cached,
    sharedInputItems: row.shared,
    previousInputItems: row.previous,
    upstreamOutcome: row.outcome,
    upstreamReason: row.reason,
  };
}

function summarize(rows, support) {
  const completed = rows.filter(row => row.status === 'completed');
  const stable = completed.filter(row => row.baseline === 'recent' && row.section === 'none');
  const stableMisses = stable.filter(row => row.cached === 0);
  const changedMisses = completed.filter(row => row.cached === 0 && !['none', 'unknown'].includes(row.section));
  const reads = completed.filter(row => row.cached > 0);
  const differences = Object.fromEntries([...changes].filter(section => section !== 'none' && section !== 'unknown')
    .map(section => [section, changedMisses.filter(row => row.section === section).length]));
  const shortGap = stableMisses.filter(row => row.baselineAgeMs !== null && row.baselineAgeMs <= 30_000 && row.overlap === false);
  const { model, session, scope, effort, toolMode, comparisonMode } = rows[0];
  return {
    model, sessionTag: session, scopeTag: scope, effort, toolMode, comparisonMode,
    requests: rows.length, completed: completed.length,
    terminalStatus: Object.fromEntries([...statuses, 'unknown'].map(status => [status, rows.filter(row => row.status === status).length])),
    cold: rows.filter(row => row.baseline === 'cold').length,
    expired: rows.filter(row => row.baseline === 'expired').length,
    unknownBaseline: rows.filter(row => row.baseline === 'unknown' || row.baseline === 'no-session-key').length,
    observedOverlap: rows.filter(row => row.overlap === true).length,
    unknownOverlap: rows.filter(row => row.overlap === undefined).length,
    cacheReads: reads.length,
    missingReadCount: completed.filter(row => row.cached === null).length,
    zeroReadStablePrefix: stableMisses.length,
    zeroReadChangedPrefix: differences,
    zeroReadWithoutComparison: completed.filter(row => row.cached === 0).length - stableMisses.length - changedMisses.length,
    stablePrefixByObservedOverlap: Object.fromEntries([['yes', true], ['no', false], ['unknown', undefined]]
      .map(([label, overlap]) => {
        const cohort = stable.filter(row => row.overlap === overlap);
        return [label, {
          cacheReads: cohort.filter(row => row.cached > 0).length,
          zeroReads: cohort.filter(row => row.cached === 0).length,
          missingReadCount: cohort.filter(row => row.cached === null).length,
        }];
      })),
    tokens: {
      input: tokens(rows, row => row.input), cached: tokens(rows, row => row.cached),
      written: tokens(rows, row => row.written), output: tokens(rows, row => row.output),
      fresh: tokens(rows, row => [row.input, row.cached, row.written].includes(null)
        ? null : count(row.input - row.cached - row.written)),
    },
    examples: { stableZeroRead: stableMisses[0] ? sample(stableMisses[0]) : null, cacheRead: reads[0] ? sample(reads[0]) : null },
    ...(support ? {
      supportCandidates: shortGap.length >= 2 ? shortGap.slice(0, 8)
        .map(row => ({ ...sample(row), upstreamRequestId: row.upstream })) : [],
    } : {}),
  };
}

function timeBoundary(value, fallback) {
  if (value === undefined) return fallback;
  const timestamp = typeof value === 'string' && /Z$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error('Use a UTC timestamp ending in Z.');
  return timestamp;
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string', multiple: true },
    since: { type: 'string' }, until: { type: 'string' },
    support: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.input?.length) throw new Error('Supply at least one input log.');
  const since = timeBoundary(values.since, -Infinity);
  const until = timeBoundary(values.until, Infinity);
  if (since > until) throw new Error('The start must precede the end.');

  const rows = new Map();
  let unclassifiedLines = 0;
  let duplicateRecords = 0;
  for (const input of values.input) {
    const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
    for await (const line of lines) {
      const row = readRecord(line);
      if (row === undefined) continue;
      if (row === null) {
        unclassifiedLines++;
        continue;
      }
      const key = JSON.stringify([row.scope, row.sequence]);
      if (rows.has(key)) duplicateRecords++;
      else rows.set(key, row);
    }
  }
  const observations = [...rows.values()];
  markOverlap(observations);
  const selected = observations.filter(row => row.start >= since && row.start <= until);
  const groups = group(selected, row => [row.model, row.session, row.scope, row.effort, row.toolMode, row.comparisonMode])
    .map(rowsInGroup => summarize(rowsInGroup.sort((a, b) => a.start - b.start || a.sequence - b.sequence), values.support));
  console.log(JSON.stringify({ observedRequests: selected.length, duplicateRecords, unclassifiedLines, groups }, null, 2));
}

main().catch(() => {
  console.error(usage);
  console.error('Could not read the diagnostic logs or arguments.');
  process.exitCode = 1;
});
