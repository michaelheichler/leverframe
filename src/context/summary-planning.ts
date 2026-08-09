import { createHash } from 'node:crypto';

export type SummaryUnitKind = 'message_group' | 'chunk_summary' | 'session_summary';

export interface SummarySourceUnit {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: SummaryUnitKind;
  tokenEstimate: number;
  chronology: number;
}

export interface SummaryBatch {
  unitIds: readonly string[];
  tokenEstimate: number;
  workspaceId: string;
  sessionId: string;
}

export interface HierarchicalSummaryPlan {
  batches: readonly SummaryBatch[];
  unmergeableUnitIds: readonly string[];
}

export interface RollingSummaryGroup {
  id: string;
  digest: string;
  tokenEstimate: number;
  chronology: number;
  compactable: boolean;
  unresolved?: boolean;
}

export interface RollingSummaryPlan {
  jobId?: string;
  blocked: boolean;
  blockedReason?: string;
  blockedIds: readonly string[];
  sourceIds: readonly string[];
  tokenEstimate: number;
  untouchedTailIds: readonly string[];
  skippedIds: readonly string[];
}

const HARD_CAP = 128_000;
const MAX_ID_LENGTH = 256;

function validBoundedString(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

function validTokens(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function digestJob(parts: readonly string[]): string {
  return `lfroll1_${createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')}`;
}

export function planHierarchicalSummaryBatches(units: readonly SummarySourceUnit[], inputTokenCap: number): HierarchicalSummaryPlan {
  if (!Number.isSafeInteger(inputTokenCap) || inputTokenCap <= 0) throw new Error('inputTokenCap must be a positive integer');
  const cap = Math.min(inputTokenCap, HARD_CAP);
  const unitIds = new Set<string>();
  const chronologyByBoundary = new Map<string, number>();
  for (const unit of units) {
    if (!validBoundedString(unit.id) || !validBoundedString(unit.workspaceId) || !validBoundedString(unit.sessionId)) throw new Error('summary unit identity is invalid');
    if (unitIds.has(unit.id)) throw new Error('summary unit IDs must be unique');
    unitIds.add(unit.id);
    if (!Number.isSafeInteger(unit.chronology)) throw new Error('summary unit chronology is invalid');
    const boundary = `${unit.workspaceId}\u0000${unit.sessionId}`;
    const previousChronology = chronologyByBoundary.get(boundary);
    if (previousChronology !== undefined && unit.chronology <= previousChronology) throw new Error('summary unit chronology must increase within each workspace/session');
    chronologyByBoundary.set(boundary, unit.chronology);
  }
  const batches: SummaryBatch[] = [];
  const unmergeableUnitIds: string[] = [];
  let current: SummaryBatch | undefined;
  for (const unit of units) {
    if (!validTokens(unit.tokenEstimate) || unit.tokenEstimate === 0) throw new Error('summary unit token estimate is invalid');
    if (unit.tokenEstimate > cap) {
      unmergeableUnitIds.push(unit.id);
      current = undefined;
      continue;
    }
    const sameBoundary = current && current.workspaceId === unit.workspaceId && current.sessionId === unit.sessionId;
    if (!sameBoundary || !current || current.tokenEstimate + unit.tokenEstimate > cap) {
      current = { unitIds: [unit.id], tokenEstimate: unit.tokenEstimate, workspaceId: unit.workspaceId, sessionId: unit.sessionId };
      batches.push(current);
    } else {
      current = { ...current, unitIds: [...current.unitIds, unit.id], tokenEstimate: current.tokenEstimate + unit.tokenEstimate };
      batches[batches.length - 1] = current;
    }
  }
  return Object.freeze({ batches: Object.freeze(batches.map(batch => Object.freeze({ ...batch, unitIds: Object.freeze([...batch.unitIds]) }))), unmergeableUnitIds: Object.freeze(unmergeableUnitIds) });
}

export function planRollingSummary(input: {
  completedGroups: readonly RollingSummaryGroup[];
  priorCursor?: string;
  rollingStride: number;
  maxRollingInput: number;
  untouchedRecentTail: number;
  policyVersion: string;
  workspaceId: string;
  sessionId: string;
}): RollingSummaryPlan {
  if (!Number.isSafeInteger(input.rollingStride) || input.rollingStride <= 0) throw new Error('rollingStride must be positive');
  if (!Number.isSafeInteger(input.maxRollingInput) || input.maxRollingInput <= 0) throw new Error('maxRollingInput must be positive');
  if (!Number.isSafeInteger(input.untouchedRecentTail) || input.untouchedRecentTail < 0) throw new Error('untouchedRecentTail must be nonnegative');
  if (!validBoundedString(input.policyVersion) || !validBoundedString(input.workspaceId) || !validBoundedString(input.sessionId)) throw new Error('rolling summary identity is invalid');
  const cap = Math.min(input.maxRollingInput, HARD_CAP);
  const groupIds = new Set<string>();
  const chronologies = new Set<number>();
  for (const group of input.completedGroups) {
    if (!validBoundedString(group.id) || !validBoundedString(group.digest)) throw new Error('rolling summary group identity is invalid');
    if (groupIds.has(group.id)) throw new Error('rolling summary group IDs must be unique');
    groupIds.add(group.id);
    if (!Number.isSafeInteger(group.chronology) || chronologies.has(group.chronology)) throw new Error('rolling summary chronology must be unique and valid');
    chronologies.add(group.chronology);
  }
  const ordered = [...input.completedGroups].sort((left, right) => left.chronology - right.chronology);
  const cursorIndex = input.priorCursor === undefined ? -1 : ordered.findIndex(group => group.id === input.priorCursor);
  if (input.priorCursor !== undefined && cursorIndex === -1) {
    return Object.freeze({ blocked: true, blockedReason: 'prior_cursor_not_found', blockedIds: Object.freeze([]), sourceIds: Object.freeze([]), tokenEstimate: 0, untouchedTailIds: Object.freeze([]), skippedIds: Object.freeze([]) });
  }
  const remaining = ordered.slice(cursorIndex + 1);
  const blockingIndex = remaining.findIndex(group => !group.compactable || group.unresolved === true || !validTokens(group.tokenEstimate) || group.tokenEstimate === 0 || group.tokenEstimate > cap);
  const eligible = blockingIndex === -1 ? remaining : remaining.slice(0, blockingIndex);
  const blockingGroup = blockingIndex === -1 ? undefined : remaining[blockingIndex];
  let tailBoundary = eligible.length;
  let tailTokens = 0;
  while (tailBoundary > 0 && tailTokens < input.untouchedRecentTail) {
    tailBoundary -= 1;
    tailTokens += eligible[tailBoundary].tokenEstimate;
  }
  const candidates = eligible.slice(0, tailBoundary);
  const selected: RollingSummaryGroup[] = [];
  let tokens = 0;
  for (const group of candidates) {
    if (tokens + group.tokenEstimate > cap) break;
    selected.push(group);
    tokens += group.tokenEstimate;
    if (tokens >= input.rollingStride) break;
  }
  const skippedIds = blockingGroup ? [blockingGroup.id] : eligible.filter(group => !selected.some(item => item.id === group.id)).map(group => group.id);
  const basePlan = { blocked: blockingGroup !== undefined, blockedReason: blockingGroup ? 'unsafe_group' : undefined, blockedIds: Object.freeze(blockingGroup ? [blockingGroup.id] : []), untouchedTailIds: Object.freeze(eligible.slice(tailBoundary).map(group => group.id)), skippedIds: Object.freeze(skippedIds) };
  if (selected.length === 0) return Object.freeze({ ...basePlan, sourceIds: Object.freeze([]), tokenEstimate: 0 });
  const jobId = digestJob([input.policyVersion, input.workspaceId, input.sessionId, ...selected.map(group => `${group.id}:${group.digest}`)]);
  return Object.freeze({ ...basePlan, jobId, sourceIds: Object.freeze(selected.map(group => group.id)), tokenEstimate: tokens });
}