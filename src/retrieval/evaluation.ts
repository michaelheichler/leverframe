import { z } from 'zod';

const MIN_PAIRS = 30;
const RESAMPLES = 2_000;
const MAX_SPEND_RATIO = 0.9;
const MIN_RESOLUTION_DELTA = -0.05;
const label = z.string().trim().min(1).max(256);
const count = z.int().min(0);
const amount = z.number().min(0);
const counters = ['freshInput', 'cacheReadInput', 'cacheWriteInput', 'output', 'toolCalls', 'repeatReads'] as const;

const armSchema = z.strictObject({
  resolved: z.boolean(),
  attempts: count.min(1),
  freshInput: count.nullable(),
  cacheReadInput: count.nullable(),
  cacheWriteInput: count.nullable(),
  output: count.nullable(),
  toolCalls: count.nullable(),
  repeatReads: count.nullable(),
  firstTextMs: amount.nullable(),
  observedSpend: amount.nullable(),
});

const inputSchema = z.strictObject({
  provider: label,
  route: label,
  model: label,
  effort: label,
  cacheIsolation: z.enum(['verified', 'unknown']),
  metric: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('actual-usd') }),
    z.strictObject({ kind: z.literal('allowance'), unit: label }),
    z.strictObject({
      kind: z.literal('modeled-usd'),
      ratesPerMillion: z.strictObject({ fresh: amount, read: amount, write: amount, output: amount }),
    }),
  ]),
  pairs: z.array(z.strictObject({
    taskId: label,
    revision: label,
    fixture: label,
    baseline: armSchema,
    retrieval: armSchema,
  })).max(10_000),
});

type EvaluationInput = z.infer<typeof inputSchema>;
type Arm = z.infer<typeof armSchema>;
type Metric = EvaluationInput['metric'];
type CostObservation = { spend: number | null; resolved: number };

interface ArmReport {
  totals: Record<(typeof counters)[number] | 'attempts', number | null>;
  medianFirstTextMs: number | null;
  firstTextSampleCount: number;
  resolved: number;
  successRate: number | null;
  spend: number | null;
  spendPerResolved: number | null;
}

export interface EvaluationReport extends Omit<EvaluationInput, 'pairs'> {
  pairCount: number;
  baseline: ArmReport;
  retrieval: ArmReport;
  relativeSpendChange: number | null;
  resolutionRateChange: number | null;
  bootstrapBounds: { upperRelativeSpendChange: number | null; lowerResolutionRateChange: number } | null;
  outcome: 'pilot-pass' | 'pilot-fail' | 'inconclusive';
}

function sumKnown(values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

function costObservation(arm: Arm, metric: Metric): CostObservation {
  const resolved = Number(arm.resolved);
  if (metric.kind !== 'modeled-usd') return { spend: arm.observedSpend, resolved };

  const { freshInput, cacheReadInput, cacheWriteInput, output } = arm;
  if (freshInput === null || cacheReadInput === null || cacheWriteInput === null || output === null) {
    return { spend: null, resolved };
  }
  const { fresh, read, write, output: outputRate } = metric.ratesPerMillion;
  return {
    spend: sumKnown([
      freshInput / 1_000_000 * fresh, cacheReadInput / 1_000_000 * read,
      cacheWriteInput / 1_000_000 * write, output / 1_000_000 * outputRate,
    ]),
    resolved,
  };
}

function summarizeArm(arms: Arm[], observations: CostObservation[]): ArmReport {
  const resolved = observations.reduce((total, observation) => total + observation.resolved, 0);
  const spend = sumKnown(observations.map(observation => observation.spend));
  const firstText = arms.flatMap(arm => arm.firstTextMs === null ? [] : [arm.firstTextMs]).sort((a, b) => a - b);
  const middle = Math.floor(firstText.length / 2);
  const medianFirstTextMs = firstText.length === 0 ? null
    : firstText.length % 2 === 1 ? firstText[middle] : firstText[middle - 1] / 2 + firstText[middle] / 2;
  const totals = Object.fromEntries(
    [...counters, 'attempts' as const].map(key => [key, sumKnown(arms.map(arm => arm[key]))]),
  ) as ArmReport['totals'];
  return {
    totals, medianFirstTextMs, firstTextSampleCount: firstText.length, resolved, spend,
    successRate: arms.length > 0 ? resolved / arms.length : null,
    spendPerResolved: resolved > 0 && spend !== null ? spend / resolved : null,
  };
}

function bootstrap(baseline: CostObservation[], retrieval: CostObservation[]): NonNullable<EvaluationReport['bootstrapBounds']> {
  const spendChanges: number[] = [];
  const resolutionChanges: number[] = [];
  let seed = 20261119;
  for (let sample = 0; sample < RESAMPLES; sample++) {
    let baselineSpend = 0;
    let retrievalSpend = 0;
    let baselineResolved = 0;
    let retrievalResolved = 0;
    for (let draw = 0; draw < baseline.length; draw++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const index = Math.floor((seed >>> 0) / 2 ** 32 * baseline.length);
      baselineSpend += baseline[index].spend!;
      retrievalSpend += retrieval[index].spend!;
      baselineResolved += baseline[index].resolved;
      retrievalResolved += retrieval[index].resolved;
    }
    const spendChange = baselineSpend > 0 && baselineResolved > 0 && retrievalResolved > 0
      ? (retrievalSpend / retrievalResolved) / (baselineSpend / baselineResolved) - 1
      : Infinity;
    spendChanges.push(Number.isFinite(spendChange) ? spendChange : Infinity);
    resolutionChanges.push((retrievalResolved - baselineResolved) / baseline.length);
  }
  spendChanges.sort((a, b) => a === b ? 0 : a - b);
  resolutionChanges.sort((a, b) => a - b);
  const upper = spendChanges[Math.ceil(0.95 * RESAMPLES) - 1];
  return {
    upperRelativeSpendChange: Number.isFinite(upper) ? upper : null,
    lowerResolutionRateChange: resolutionChanges[Math.ceil(0.05 * RESAMPLES) - 1],
  };
}

export function evaluateRetrieval(input: unknown): EvaluationReport {
  const { pairs, ...identity } = inputSchema.parse(input);
  if (new Set(pairs.map(pair => pair.taskId)).size !== pairs.length) throw new Error('Task IDs must be unique.');

  const baselineArms = pairs.map(pair => pair.baseline);
  const retrievalArms = pairs.map(pair => pair.retrieval);
  const baselineCosts = baselineArms.map(arm => costObservation(arm, identity.metric));
  const retrievalCosts = retrievalArms.map(arm => costObservation(arm, identity.metric));
  const baseline = summarizeArm(baselineArms, baselineCosts);
  const retrieval = summarizeArm(retrievalArms, retrievalCosts);
  const baselineCost = baseline.spendPerResolved;
  const retrievalCost = retrieval.spendPerResolved;
  const ratio = baselineCost !== null && baselineCost > 0 && retrievalCost !== null ? retrievalCost / baselineCost : null;
  const comparableRatio = ratio !== null && Number.isFinite(ratio) ? ratio : null;
  const bootstrapBounds = comparableRatio !== null && pairs.length >= MIN_PAIRS && identity.cacheIsolation === 'verified'
    ? bootstrap(baselineCosts, retrievalCosts) : null;
  const upper = bootstrapBounds?.upperRelativeSpendChange;
  const outcome = comparableRatio === null || !bootstrapBounds || upper == null ? 'inconclusive'
    : comparableRatio <= MAX_SPEND_RATIO && upper < 0 && bootstrapBounds.lowerResolutionRateChange >= MIN_RESOLUTION_DELTA
      ? 'pilot-pass' : 'pilot-fail';

  return {
    ...identity, pairCount: pairs.length, baseline, retrieval,
    relativeSpendChange: comparableRatio === null ? null : comparableRatio - 1,
    resolutionRateChange: pairs.length > 0 ? (retrieval.resolved - baseline.resolved) / pairs.length : null,
    bootstrapBounds, outcome,
  };
}
