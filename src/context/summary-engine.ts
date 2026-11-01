import { estimateAnthropicInputTokens } from '../anthropic-endpoints.js';
import { groupAnthropicContext, isJsonShapedAnthropicMessage } from './anthropic-context-groups.js';
import type { EvidenceStore } from './evidence-store.js';
import { compactAnthropicRequest, type AnthropicRequestLike } from './request-compaction.js';
import { planRollingSummary } from './summary-planning.js';
import { acceptStructuredSynopsis, type StructuredSynopsis } from './summary-schema.js';
import { reserveSummarySpend, settleSummarySpend } from './summary-spend.js';
import { findSummaryCache, saveSummaryCache } from './summary-cache.js';

export interface SummaryUsage { inputTokens: number; outputTokens: number; costMicros?: number }
export interface SummaryEngine {
  identity: string;
  billing: 'local' | 'paid';
  summarize(input: { sourceText: string; sourceIds: readonly string[]; maxInputTokens: number; maxOutputTokens: number; signal: AbortSignal }): Promise<{ synopsis: StructuredSynopsis | null; sourceIds: readonly string[]; usage: SummaryUsage }>;
}
export interface SummaryPricing { inputMicrosPerMillion: number; outputMicrosPerMillion: number; provenance: string }
export interface SummaryOptions {
  workspaceId: string; policyVersion: string; generation: string;
  maxInputTokens: number; maxOutputTokens: number; deadlineMs: number;
  untouchedRecentTail: number; rollingStride: number;
  lifetimeLimitMicros?: number; pricing?: SummaryPricing;
  persistentCache?: boolean;
}
export interface SummaryLedger {
  reserve(input: { limitMicros: number; maximumMicros: number }): string | undefined;
  settle(id: string, actualMicros?: number): void;
}

const cache = new WeakMap<EvidenceStore, Map<string, { synopsis: StructuredSynopsis; usage: SummaryUsage; references: string[]; createdAt: number }>>();
type CacheEntry = { synopsis: StructuredSynopsis; usage: SummaryUsage; references: string[]; createdAt: number };
type Group = ReturnType<typeof groupAnthropicContext>['groups'][number];

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function price(input: number, output: number, pricing: SummaryPricing | undefined): number | undefined {
  if (!pricing || !integer(pricing.inputMicrosPerMillion) || !integer(pricing.outputMicrosPerMillion) || typeof pricing.provenance !== 'string' || !pricing.provenance.trim()) return undefined;
  const cost = (BigInt(input) * BigInt(pricing.inputMicrosPerMillion) + BigInt(output) * BigInt(pricing.outputMicrosPerMillion) + 999_999n) / 1_000_000n;
  return cost <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cost) : undefined;
}

function eligible(group: Group): boolean {
  return group.kind === 'tool_pair' && group.compactable && group.messages.every(message => Object.keys(message).every(key => key === 'role' || key === 'content') && Array.isArray(message.content) && message.content.length > 0 && message.content.every(block => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
    if (message.role === 'assistant') return Object.keys(block).every(key => ['type', 'id', 'name', 'input'].includes(key)) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && !!block.input && typeof block.input === 'object' && !Array.isArray(block.input);
    return message.role === 'user' && Object.keys(block).every(key => ['type', 'tool_use_id', 'content', 'is_error'].includes(key)) && block.type === 'tool_result' && typeof block.content === 'string' && (block.is_error === undefined || block.is_error === false);
  }));
}

async function loadCached(store: EvidenceStore, sessionId: string, key: string, persistent: boolean): Promise<CacheEntry | undefined> {
  const memory = cache.get(store)?.get(key);
  if (memory || !persistent) return memory;
  try {
    const reference = findSummaryCache(key);
    return reference ? JSON.parse(await store.get(sessionId, reference)) as CacheEntry : undefined;
  } catch { return undefined; }
}

async function saveCached(store: EvidenceStore, sessionId: string, key: string, entry: CacheEntry, persistent: boolean): Promise<void> {
  const entries = cache.get(store) ?? new Map();
  entries.set(key, entry);
  cache.set(store, entries);
  if (!persistent) return;
  try {
    const serialized = JSON.stringify(entry);
    const reference = await store.put(sessionId, serialized);
    if (await store.get(sessionId, reference) === serialized) saveSummaryCache(key, reference);
  } catch { /* The request remains valid without a persistent cache. */ }
}

async function validCached(store: EvidenceStore, sessionId: string, saved: CacheEntry, selected: readonly Group[], sourceIds: readonly string[], tokens: number): Promise<boolean> {
  if (!Number.isSafeInteger(saved.createdAt) || Date.now() < saved.createdAt || Date.now() - saved.createdAt >= 30 * 86_400_000) return false;
  const checked = acceptStructuredSynopsis({ candidate: saved.synopsis, suppliedSourceIds: sourceIds, inputTokens: tokens });
  if (!checked.accepted || !saved.usage || !integer(saved.usage.inputTokens) || saved.usage.inputTokens === 0 || !integer(saved.usage.outputTokens) || saved.usage.outputTokens === 0 || !Array.isArray(saved.references) || saved.references.length !== selected.length || !saved.references.every(reference => /^lfe1_[a-f0-9]{48}$/.test(reference))) return false;
  const contents = await Promise.all(saved.references.map(reference => store.get(sessionId, reference)));
  return contents.every((content, index) => content === JSON.stringify(selected[index]?.messages));
}

async function invokeEngine(engine: SummaryEngine, sourceText: string, sourceIds: readonly string[], options: SummaryOptions, signal: AbortSignal): Promise<Awaited<ReturnType<SummaryEngine['summarize']>>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, options.deadlineMs);
  try {
    if (controller.signal.aborted) throw new Error('summary aborted');
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('summary aborted')), { once: true }));
    return await Promise.race([aborted, engine.summarize({ sourceText, sourceIds, maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens, signal: controller.signal })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function applySummaryStage<T extends AnthropicRequestLike>(input: {
  request: T; sessionId: string; routeIdentity: string; engine: SummaryEngine; store: EvidenceStore; signal: AbortSignal; options: SummaryOptions; ledger?: SummaryLedger;
}): Promise<{ request: T; summarized: boolean; reused: boolean; usage?: SummaryUsage; chargedMicros?: number }> {
  const unchanged: { request: T; summarized: boolean; reused: boolean; usage?: SummaryUsage; chargedMicros?: number } = { request: input.request, summarized: false, reused: false };
  let outcome = unchanged;
  const { options, signal, engine } = input;
  if (signal.aborted || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId) || !Array.isArray(input.request.messages) || !input.request.messages.every(isJsonShapedAnthropicMessage)) return unchanged;
  if (![options.maxInputTokens, options.maxOutputTokens, options.deadlineMs, options.rollingStride].every(value => integer(value) && value > 0) || !integer(options.untouchedRecentTail)) return unchanged;
  let reservation: string | undefined;
  let actualCost: number | undefined;
  const ledger = input.ledger ?? { reserve: reserveSummarySpend, settle: settleSummarySpend };
  try {
    const partition = groupAnthropicContext(input.request.messages);
    if (partition.diagnostics.length) return unchanged;
    const groups = partition.groups.filter(eligible);
    const plan = planRollingSummary({ completedGroups: groups.map((group, chronology) => ({ id: group.sourceDigest, digest: group.sourceDigest, tokenEstimate: Math.ceil(Buffer.byteLength(JSON.stringify(group.messages)) / 4), chronology, compactable: true })), rollingStride: options.rollingStride, maxRollingInput: options.maxInputTokens, untouchedRecentTail: options.untouchedRecentTail, policyVersion: options.policyVersion, workspaceId: options.workspaceId, sessionId: input.sessionId });
    if (!plan.jobId || !plan.sourceIds.length) return unchanged;
    const selected = groups.filter(group => plan.sourceIds.includes(group.sourceDigest));
    const sourceText = JSON.stringify(selected.map(group => ({ sourceId: group.sourceDigest, messages: group.messages })));
    if (Buffer.byteLength(sourceText) > options.maxInputTokens * 4) return unchanged;
    const cacheKey = JSON.stringify([plan.jobId, input.routeIdentity, options.generation, engine.identity, options.maxInputTokens, options.maxOutputTokens]);
    const saved = await loadCached(input.store, input.sessionId, cacheKey, options.persistentCache === true);
    if (saved && await validCached(input.store, input.sessionId, saved, selected, plan.sourceIds, plan.tokenEstimate)) {
      const reused = compactResult(input, partition.groups, selected, plan.untouchedTailIds, saved.synopsis, saved.references);
      if (reused && !signal.aborted) return { request: reused, summarized: true, reused: true, usage: saved.usage };
    }
    if (engine.billing === 'paid') {
      const maximumMicros = price(options.maxInputTokens, options.maxOutputTokens, options.pricing);
      if (maximumMicros === undefined || !integer(options.lifetimeLimitMicros) || options.lifetimeLimitMicros === 0) return unchanged;
      reservation = ledger.reserve({ limitMicros: options.lifetimeLimitMicros, maximumMicros });
      if (!reservation) return unchanged;
      unchanged.chargedMicros = maximumMicros;
      if (signal.aborted) return unchanged;
    }
    const result = await invokeEngine(engine, sourceText, plan.sourceIds, options, signal);
    const usage = result?.usage;
    if (!usage || !integer(usage.inputTokens) || !integer(usage.outputTokens) || usage.inputTokens === 0 || usage.outputTokens === 0 || usage.inputTokens > options.maxInputTokens || usage.outputTokens > options.maxOutputTokens) return unchanged;
    unchanged.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    if (usage.costMicros !== undefined && !integer(usage.costMicros)) return unchanged;
    if (engine.billing === 'paid') {
      const computed = price(usage.inputTokens, usage.outputTokens, options.pricing);
      if (computed === undefined || (usage.costMicros !== undefined && usage.costMicros > computed)) return unchanged;
      actualCost = computed;
    }
    unchanged.usage = { ...usage, ...(actualCost === undefined ? {} : { costMicros: actualCost }) };
    if (signal.aborted || !Array.isArray(result.sourceIds) || result.sourceIds.length !== plan.sourceIds.length || result.sourceIds.some((id, index) => id !== plan.sourceIds[index])) return unchanged;
    const accepted = acceptStructuredSynopsis({ candidate: result.synopsis, suppliedSourceIds: plan.sourceIds, inputTokens: plan.tokenEstimate });
    if (!accepted.accepted || !accepted.synopsis) return unchanged;
    const references: string[] = [];
    for (const group of selected) {
      const content = JSON.stringify(group.messages);
      const reference = await input.store.put(input.sessionId, content);
      if (signal.aborted || !/^lfe1_[a-f0-9]{48}$/.test(reference) || await input.store.get(input.sessionId, reference) !== content) return unchanged;
      references.push(reference);
    }
    const compacted = compactResult(input, partition.groups, selected, plan.untouchedTailIds, accepted.synopsis, references);
    if (!compacted || signal.aborted) return unchanged;
    const recordedUsage = { ...usage, ...(actualCost === undefined ? {} : { costMicros: actualCost }) };
    const cacheEntry = { synopsis: accepted.synopsis, usage: recordedUsage, references, createdAt: Date.now() };
    await saveCached(input.store, input.sessionId, cacheKey, cacheEntry, options.persistentCache === true);
    outcome = { request: compacted, summarized: true, reused: false, usage: recordedUsage, chargedMicros: unchanged.chargedMicros };
    return outcome;
  } catch {
    return unchanged;
  } finally {
    if (reservation) {
      try {
        ledger.settle(reservation, actualCost);
        if (actualCost !== undefined) outcome.chargedMicros = actualCost;
      } catch { /* Reservation remains charged. */ }
    }
  }
}

function compactResult<T extends AnthropicRequestLike>(input: { request: T; sessionId: string; routeIdentity: string; options: SummaryOptions }, groups: ReturnType<typeof groupAnthropicContext>['groups'], selected: ReturnType<typeof groupAnthropicContext>['groups'], tail: readonly string[], synopsis: StructuredSynopsis, references: string[]): T | undefined {
  const text = JSON.stringify({ synopsis, evidence: references.map(reference => ({ reference, retrieve: `leverframe evidence get '${input.sessionId}' '${reference}'` })) });
  const result = compactAnthropicRequest({ request: input.request, groups, synopsis: { text }, coveredSources: selected.map(group => ({ sourceDigest: group.sourceDigest })), untouchedTailGroupIds: tail, routeIdentity: input.routeIdentity, policyVersion: input.options.policyVersion, generation: input.options.generation, estimateTokens: estimateAnthropicInputTokens, lowWatermark: estimateAnthropicInputTokens(input.request) - 1 });
  return result.ok ? result.compactedRequest : undefined;
}
