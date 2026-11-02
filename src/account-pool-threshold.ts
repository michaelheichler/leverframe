import type { CapacityObservation, PoolAccount } from './account-pool.js';

type Candidate = { account: PoolAccount; observations: CapacityObservation[] };
export const QUOTA_THRESHOLD_OBSERVATION_MAX_AGE_MS = 60_000;

function percentages(observations: CapacityObservation[], now: number): Map<string, number> | undefined {
  const result = new Map<string, number>();
  for (const observation of observations) {
    if (observation.source === 'pool:recovery' && observation.status === 'healthy') continue;
    const remaining = observation.remaining;
    if (observation.status !== 'healthy' || !Number.isFinite(observation.observedAt)
      || observation.observedAt > now || now - observation.observedAt > QUOTA_THRESHOLD_OBSERVATION_MAX_AGE_MS
      || (observation.resetAt !== undefined && (typeof observation.resetAt !== 'number'
        || !Number.isFinite(observation.resetAt) || observation.resetAt <= now))
      || !remaining || !Number.isFinite(remaining.value)
      || remaining.value < 0 || !Number.isFinite(remaining.limit) || !remaining.limit
      || remaining.limit <= 0 || remaining.value > remaining.limit || !remaining.unit) return undefined;
    const scope = observation.scope.kind === 'shared' ? ['shared', observation.scope.bucketId] : [observation.scope.kind];
    const dimension = JSON.stringify([...scope, observation.dimension ?? '', remaining.unit]);
    if (result.has(dimension)) return undefined;
    result.set(dimension, remaining.value / remaining.limit * 100);
  }
  return result.size ? result : undefined;
}

export function thresholdAlternative<T extends Candidate>(current: T, eligible: T[], threshold: number, now: number): T | undefined {
  if (threshold <= 0) return undefined;
  const baseline = percentages(current.observations, now);
  if (!baseline || Math.min(...baseline.values()) > threshold) return undefined;
  let selected: T | undefined;
  let best = -1;
  for (const candidate of eligible) {
    if (candidate.account.id === current.account.id) continue;
    const values = percentages(candidate.observations, now);
    if (!values || values.size !== baseline.size) continue;
    const comparable = [...baseline].every(([dimension, value]) => {
      const alternative = values.get(dimension);
      return alternative !== undefined && alternative > threshold && alternative >= value;
    });
    if (!comparable) continue;
    const minimum = Math.min(...values.values());
    if (minimum > best) { selected = candidate; best = minimum; }
  }
  return selected;
}
