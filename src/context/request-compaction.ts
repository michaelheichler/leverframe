import { createHash } from 'node:crypto';
import type { ContextGroupView } from './anthropic-context-groups.js';

export type CompactionJson = null | boolean | number | string | CompactionJson[] | { [key: string]: CompactionJson };

export interface CompactionMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface AnthropicRequestLike {
  messages: readonly CompactionMessage[];
  system?: unknown;
  [key: string]: unknown;
}

export interface CompactionGroup {
  groupId?: string;
  sourceDigest: string;
  messageIndexes: readonly number[];
  messages: readonly CompactionMessage[];
  compactable: boolean;
  kind?: string;
}

export type CompatibleCompactionGroup = CompactionGroup | ContextGroupView;

export interface CoveredSource {
  groupId?: string;
  sourceDigest: string;
}

export interface CompactionIdentity {
  routeIdentity: string;
  policyVersion: string;
  generation: string;
}

export interface StructuredSynopsis {
  text: string;
  [key: string]: CompactionJson;
}

export interface LeverframeSummaryEnvelope extends CompactionIdentity {
  schemaVersion: 1;
  kind: 'leverframe_summary';
  summaryGeneration: string;
  coveredSources: readonly CoveredSource[];
  synopsis: Readonly<StructuredSynopsis>;
  decisionKey: string;
}

export type CompactionFailureReason =
  | 'invalid_request'
  | 'invalid_partition'
  | 'invalid_coverage'
  | 'uncompactable_group'
  | 'envelope_malformed'
  | 'envelope_duplicate'
  | 'identity_mismatch'
  | 'tool_boundary'
  | 'estimate_above_low_watermark'
  | 'estimator_unavailable';

export interface CompactionSuccess<T extends AnthropicRequestLike> {
  ok: true;
  compactedRequest: T;
  decisionKey: string;
  alreadyCompacted: boolean;
}

export interface CompactionFailure<T extends AnthropicRequestLike> {
  ok: false;
  originalRequest: T;
  reason: CompactionFailureReason;
  decisionKey: string;
}

export type CompactionResult<T extends AnthropicRequestLike> = CompactionSuccess<T> | CompactionFailure<T>;

export interface RequestCompactionInput<T extends AnthropicRequestLike> extends CompactionIdentity {
  request: T;
  groups: readonly CompatibleCompactionGroup[];
  synopsis: StructuredSynopsis;
  coveredSources: readonly CoveredSource[];
  untouchedTailGroupIds: readonly string[];
  estimateTokens: (request: T) => number;
  lowWatermark: number;
}

const SUMMARY_PREFIX = 'LEVERFRAME_SUMMARY_V1:';
const MAX_ENVELOPE_BYTES = 32_768;
const MAX_SOURCES = 512;
const MAX_SYNOPSIS_BYTES = 16_384;
const MAX_IDENTITY_BYTES = 512;
const MAX_SOURCE_ID_BYTES = 512;
const DECISION_KEY_PATTERN = /^lfcmp1_[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `lfcmp1_${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(item => deepFreeze(item));
  } else if (isRecord(value)) {
    Object.values(value).forEach(item => deepFreeze(item));
  }
  return Object.freeze(value);
}

function isCompactionJson(value: unknown): value is CompactionJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCompactionJson);
  return isRecord(value) && Object.values(value).every(isCompactionJson);
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key));
}

function validCoveredSources(value: unknown): value is readonly CoveredSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCES) return false;
  const sourceDigests = new Set<string>();
  const groupIds = new Set<string>();
  return value.every(source => {
    if (!isRecord(source) || !Object.keys(source).every(key => key === 'sourceDigest' || key === 'groupId') || !hasExactKeys(source, source.groupId === undefined ? ['sourceDigest'] : ['groupId', 'sourceDigest']) || !boundedString(source.sourceDigest, MAX_SOURCE_ID_BYTES) || (source.groupId !== undefined && !boundedString(source.groupId, MAX_SOURCE_ID_BYTES))) return false;
    if (sourceDigests.has(source.sourceDigest)) return false;
    if (source.groupId !== undefined && groupIds.has(source.groupId)) return false;
    sourceDigests.add(source.sourceDigest);
    if (source.groupId !== undefined) groupIds.add(source.groupId);
    return true;
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function groupKey(group: CompatibleCompactionGroup): string {
  return ('groupId' in group ? group.groupId : undefined) ?? group.sourceDigest;
}

function groupId(group: CompatibleCompactionGroup): string | undefined {
  return 'groupId' in group ? group.groupId : undefined;
}

function toolIds(message: CompactionMessage, type: 'tool_use' | 'tool_result'): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap(block => {
    if (!isRecord(block) || block.type !== type) return [];
    const field = type === 'tool_use' ? block.id : block.tool_use_id;
    return typeof field === 'string' ? [field] : [];
  });
}

function resultFailure<T extends AnthropicRequestLike>(
  request: T,
  reason: CompactionFailureReason,
  decisionKey: string,
): CompactionFailure<T> {
  return Object.freeze({ ok: false, originalRequest: request, reason, decisionKey });
}

function resultKey(input: Pick<RequestCompactionInput<AnthropicRequestLike>, 'routeIdentity' | 'policyVersion' | 'generation' | 'coveredSources' | 'synopsis'>): string {
  return digest({
    routeIdentity: input.routeIdentity,
    policyVersion: input.policyVersion,
    generation: input.generation,
    coveredSources: input.coveredSources,
    synopsis: input.synopsis,
  });
}

function summaryMessage(envelope: LeverframeSummaryEnvelope): CompactionMessage {
  const text = `${SUMMARY_PREFIX}${stableJson(envelope)}`;
  return deepFreeze({ role: 'user', content: [{ type: 'text', text }] });
}

function parseEnvelope(message: CompactionMessage): { state: 'none' } | { state: 'malformed' } | { state: 'valid'; envelope: LeverframeSummaryEnvelope } {
  if (!Array.isArray(message.content)) return { state: 'none' };
  const marked = message.content.filter(item => isRecord(item) && typeof item.type === 'string' && item.type === 'text' && typeof item.text === 'string' && item.text.startsWith(SUMMARY_PREFIX));
  if (marked.length === 0) return { state: 'none' };
  if (message.role !== 'user' || message.content.length !== 1 || marked.length !== 1) return { state: 'malformed' };
  try {
    const parsed: unknown = JSON.parse((marked[0] as { text: string }).text.slice(SUMMARY_PREFIX.length));
    if (!isRecord(parsed)
      || !hasExactKeys(parsed, ['coveredSources', 'decisionKey', 'generation', 'kind', 'policyVersion', 'routeIdentity', 'schemaVersion', 'summaryGeneration', 'synopsis'])
      || parsed.schemaVersion !== 1
      || parsed.kind !== 'leverframe_summary'
      || !boundedString(parsed.summaryGeneration, MAX_IDENTITY_BYTES)
      || !boundedString(parsed.routeIdentity, MAX_IDENTITY_BYTES)
      || !boundedString(parsed.policyVersion, MAX_IDENTITY_BYTES)
      || !boundedString(parsed.generation, MAX_IDENTITY_BYTES)
      || typeof parsed.decisionKey !== 'string'
      || !DECISION_KEY_PATTERN.test(parsed.decisionKey)
      || !validCoveredSources(parsed.coveredSources)
      || !isRecord(parsed.synopsis)
      || !boundedString(parsed.synopsis.text, MAX_SYNOPSIS_BYTES)
      || !Object.values(parsed.synopsis).every(isCompactionJson)) return { state: 'malformed' };
    const envelope = parsed as unknown as LeverframeSummaryEnvelope;
    if (Buffer.byteLength(stableJson(envelope), 'utf8') > MAX_ENVELOPE_BYTES || digest({
      schemaVersion: envelope.schemaVersion,
      kind: envelope.kind,
      summaryGeneration: envelope.summaryGeneration,
      routeIdentity: envelope.routeIdentity,
      policyVersion: envelope.policyVersion,
      generation: envelope.generation,
      coveredSources: envelope.coveredSources,
      synopsis: envelope.synopsis,
    }) !== envelope.decisionKey) return { state: 'malformed' };
    return { state: 'valid', envelope };
  } catch {
    return { state: 'malformed' };
  }
}

export function createLeverframeSummaryEnvelope(input: {
  summaryGeneration: string;
  identity: CompactionIdentity;
  coveredSources: readonly CoveredSource[];
  synopsis: StructuredSynopsis;
}): LeverframeSummaryEnvelope {
  if (!boundedString(input.summaryGeneration, MAX_IDENTITY_BYTES) || !boundedString(input.identity.routeIdentity, MAX_IDENTITY_BYTES) || !boundedString(input.identity.policyVersion, MAX_IDENTITY_BYTES) || !boundedString(input.identity.generation, MAX_IDENTITY_BYTES)) throw new Error('invalid summary identity');
  if (!validCoveredSources(input.coveredSources)) throw new Error('invalid summary coverage');
  if (!isRecord(input.synopsis) || !boundedString(input.synopsis.text, MAX_SYNOPSIS_BYTES) || !isCompactionJson(input.synopsis)) throw new Error('invalid summary synopsis');
  const envelopeBase = {
    schemaVersion: 1 as const,
    kind: 'leverframe_summary' as const,
    summaryGeneration: input.summaryGeneration,
    routeIdentity: input.identity.routeIdentity,
    policyVersion: input.identity.policyVersion,
    generation: input.identity.generation,
    coveredSources: input.coveredSources.map(source => ({ ...source })),
    synopsis: { ...input.synopsis },
  };
  const decisionKey = digest(envelopeBase);
  const envelope = { ...envelopeBase, decisionKey };
  if (Buffer.byteLength(stableJson(envelope), 'utf8') > MAX_ENVELOPE_BYTES || Buffer.byteLength(stableJson(input.synopsis), 'utf8') > MAX_SYNOPSIS_BYTES) throw new Error('summary exceeds bound');
  return deepFreeze(envelope);
}

export function isLeverframeSummaryMessage(message: CompactionMessage): boolean {
  return parseEnvelope(message).state === 'valid';
}

export function compactAnthropicRequest<T extends AnthropicRequestLike>(input: RequestCompactionInput<T>): CompactionResult<T> {
  const decisionKey = resultKey(input);
  if (!Array.isArray(input.request.messages) || !Number.isFinite(input.lowWatermark) || input.lowWatermark < 0) return resultFailure(input.request, 'invalid_request', decisionKey);

  let envelopeCount = 0;
  let existingEnvelope: LeverframeSummaryEnvelope | undefined;
  for (const message of input.request.messages) {
    const parsed = parseEnvelope(message);
    if (parsed.state === 'malformed') return resultFailure(input.request, 'envelope_malformed', decisionKey);
    if (parsed.state === 'valid') {
      envelopeCount += 1;
      existingEnvelope = parsed.envelope;
    }
  }
  if (envelopeCount > 1) return resultFailure(input.request, 'envelope_duplicate', decisionKey);
  if (existingEnvelope) {
    let expectedEnvelope: LeverframeSummaryEnvelope;
    try {
      expectedEnvelope = createLeverframeSummaryEnvelope({ summaryGeneration: input.generation, identity: input, coveredSources: input.coveredSources, synopsis: input.synopsis });
    } catch {
      return resultFailure(input.request, 'identity_mismatch', decisionKey);
    }
    if (stableJson(existingEnvelope) !== stableJson(expectedEnvelope)) return resultFailure(input.request, 'identity_mismatch', decisionKey);
    return Object.freeze({ ok: true, compactedRequest: input.request, decisionKey: expectedEnvelope.decisionKey, alreadyCompacted: true });
  }

  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  let invalidToolTopology = false;
  for (const message of input.request.messages) {
    for (const id of toolIds(message, 'tool_use')) {
      if (message.role !== 'assistant' || toolUses.has(id)) invalidToolTopology = true;
      toolUses.add(id);
    }
    for (const id of toolIds(message, 'tool_result')) {
      if (message.role !== 'user' || toolResults.has(id)) invalidToolTopology = true;
      toolResults.add(id);
    }
  }
  if ([...toolResults].some(id => !toolUses.has(id)) || [...toolUses].some(id => !toolResults.has(id))) invalidToolTopology = true;
  if (invalidToolTopology) return resultFailure(input.request, 'tool_boundary', decisionKey);

  const groupKeys = new Set<string>();
  const digests = new Set<string>();
  const groupIds = new Set<string>();
  const coveredKeys = new Set<string>();
  const tailKeys = new Set<string>();
  const groupsByKey = new Map<string, CompatibleCompactionGroup>();
  const groupsByDigest = new Map<string, CompatibleCompactionGroup>();
  const occupied = new Set<number>();
  for (const group of input.groups) {
    const key = groupKey(group);
    const id = groupId(group);
    if (!key || groupKeys.has(key) || digests.has(group.sourceDigest) || (id !== undefined && groupIds.has(id)) || group.messageIndexes.length !== group.messages.length || group.messageIndexes.length === 0) return resultFailure(input.request, 'invalid_partition', decisionKey);
    groupKeys.add(key);
    digests.add(group.sourceDigest);
    if (id !== undefined) groupIds.add(id);
    groupsByKey.set(key, group);
    groupsByDigest.set(group.sourceDigest, group);
    for (let offset = 0; offset < group.messageIndexes.length; offset += 1) {
      const index = group.messageIndexes[offset];
      if (!Number.isInteger(index) || index < 0 || index >= input.request.messages.length || occupied.has(index) || (offset > 0 && index !== group.messageIndexes[offset - 1] + 1) || !sameValue(group.messages[offset], input.request.messages[index])) return resultFailure(input.request, 'invalid_partition', decisionKey);
      occupied.add(index);
    }
  }
  const groupAtIndex = new Map<number, CompatibleCompactionGroup>();
  for (const group of input.groups) group.messageIndexes.forEach(index => groupAtIndex.set(index, group));
  const toolUseGroups = new Map<string, CompatibleCompactionGroup>();
  for (const [index, message] of input.request.messages.entries()) {
    const group = groupAtIndex.get(index);
    if (!group) continue;
    for (const id of toolIds(message, 'tool_use')) toolUseGroups.set(id, group);
    for (const id of toolIds(message, 'tool_result')) {
      const useGroup = toolUseGroups.get(id);
      if (useGroup && useGroup !== group) return resultFailure(input.request, 'tool_boundary', decisionKey);
    }
  }
  const requiredIndexes = input.request.messages.flatMap((message, index) => message.role === 'system' ? [] : [index]);
  if (occupied.size !== requiredIndexes.length || requiredIndexes.some(index => !occupied.has(index))) return resultFailure(input.request, 'invalid_partition', decisionKey);
  for (const source of input.coveredSources) {
    const key = source.groupId ?? source.sourceDigest;
    if (!source.sourceDigest || coveredKeys.has(key) || input.coveredSources.slice(0, input.coveredSources.indexOf(source)).some(previous => previous.sourceDigest === source.sourceDigest || (source.groupId !== undefined && previous.groupId === source.groupId))) return resultFailure(input.request, 'invalid_coverage', decisionKey);
    const group = source.groupId === undefined ? groupsByDigest.get(source.sourceDigest) : groupsByKey.get(source.groupId);
    if (!group || group.sourceDigest !== source.sourceDigest || !group.compactable) return resultFailure(input.request, group && !group.compactable ? 'uncompactable_group' : 'invalid_coverage', decisionKey);
    coveredKeys.add(groupKey(group));
  }
  for (const key of input.untouchedTailGroupIds) {
    if (!key || tailKeys.has(key) || !groupsByKey.has(key)) return resultFailure(input.request, 'invalid_coverage', decisionKey);
    tailKeys.add(key);
  }
  if ([...coveredKeys].some(key => tailKeys.has(key))) return resultFailure(input.request, 'invalid_coverage', decisionKey);
  if (input.coveredSources.length === 0 || coveredKeys.size !== input.coveredSources.length) return resultFailure(input.request, 'invalid_coverage', decisionKey);

  let envelope: LeverframeSummaryEnvelope;
  try {
    envelope = createLeverframeSummaryEnvelope({ summaryGeneration: input.generation, identity: input, coveredSources: input.coveredSources, synopsis: input.synopsis });
  } catch {
    return resultFailure(input.request, 'invalid_coverage', decisionKey);
  }
  const firstCoveredIndex = Math.min(...[...coveredKeys].flatMap(key => [...(groupsByKey.get(key)?.messageIndexes ?? [])]));
  const replacement = summaryMessage(envelope);
  const messages: CompactionMessage[] = [];
  let inserted = false;
  for (const [index, message] of input.request.messages.entries()) {
    const group = input.groups.find(candidate => candidate.messageIndexes.includes(index));
    if (index === firstCoveredIndex) {
      messages.push(replacement);
      inserted = true;
    }
    if (!group || !coveredKeys.has(groupKey(group))) messages.push(message);
  }
  if (!inserted) return resultFailure(input.request, 'invalid_coverage', decisionKey);
  const compactedRequest = Object.freeze({ ...input.request, messages: Object.freeze(messages) }) as T;
  let estimate: number;
  try {
    estimate = input.estimateTokens(compactedRequest);
  } catch {
    return resultFailure(input.request, 'estimator_unavailable', decisionKey);
  }
  if (!Number.isFinite(estimate)) return resultFailure(input.request, 'estimator_unavailable', decisionKey);
  if (estimate > input.lowWatermark) return resultFailure(input.request, 'estimate_above_low_watermark', decisionKey);
  return Object.freeze({ ok: true, compactedRequest, decisionKey: envelope.decisionKey, alreadyCompacted: false });
}