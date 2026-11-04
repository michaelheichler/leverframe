import type { CostSnapshot } from './model-routing-catalog.js';

export interface RoutingWorkload {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrites?: { ttlSeconds: number; tokens: number }[];
}

export interface WorkloadEstimate {
  kind: 'known' | 'unknown';
  amount?: number;
  snapshot: CostSnapshot;
}

export function estimateWorkload(snapshot: CostSnapshot, workload: RoutingWorkload): WorkloadEstimate {
  const unknown = (): WorkloadEstimate => ({ kind: 'unknown', snapshot });
  if (workload.input === undefined || workload.output === undefined) return unknown();
  const counts = [workload.input, workload.output, workload.cacheRead ?? 0, workload.cacheWrite ?? 0,
    ...(workload.cacheWrites ?? []).map(write => write.tokens)];
  if (snapshot.kind !== 'known' || counts.some(value => !Number.isFinite(value) || value < 0)) return unknown();
  const context = counts[0]! + counts[2]! + counts[3]! + counts.slice(4).reduce((a, b) => a + b, 0);
  const tiers = snapshot.tiers ?? [];
  if (tiers.some(tier => !tier.condition)) return unknown();
  if (tiers.some(tier => tier.condition?.size === context)) return unknown();
  const tier = tiers.filter(item => item.condition && context > item.condition.size)
    .sort((a, b) => b.condition!.size - a.condition!.size)[0];
  const rates = tier ?? snapshot;
  const entries: [number, number | undefined][] = [
    [workload.input, rates.input], [workload.output, rates.output],
    [workload.cacheRead ?? 0, rates.cacheRead], [workload.cacheWrite ?? 0, rates.cacheWrite],
    ...(workload.cacheWrites ?? []).map(write => [write.tokens, rates.cacheWrites?.find(rate => rate.ttlSeconds === write.ttlSeconds)?.rate] as [number, number | undefined]),
  ];
  if (entries.some(([tokens, rate]) => tokens > 0 && (rate === undefined || !Number.isFinite(rate) || rate < 0))) return unknown();
  const multiplier = snapshot.usageMultiplierApplies ? snapshot.usageMultiplier : 1;
  if (multiplier === undefined || !Number.isFinite(multiplier) || multiplier < 0) return unknown();
  const amount = entries.reduce((sum, [tokens, rate]) => sum + tokens * (rate ?? 0), 0) * multiplier / 1_000_000;
  return Number.isFinite(amount) ? { kind: 'known', amount, snapshot } : unknown();
}
