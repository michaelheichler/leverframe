import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes } from 'node:crypto';
import { compareChatGptPlanPrefixes, fingerprintChatGptPlanPrefix } from './openai-chatgpt-plan-cache-prefix.js';

const SESSION_CACHE_KEY = /^relay-session-[0-9a-f]{32}$/;
const RESPONSE_ID = /^resp_[A-Za-z0-9_-]{1,192}$/;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{1,192}$/;
const MAX_SESSIONS = 64;
const MAX_BASELINE_AGE_MS = 15 * 60 * 1000;
const sessionTagKey = randomBytes(32);

export type ChatGptPlanCompletedResponse = {
  id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
  prompt_cache_diagnostics?: {
    type?: string;
    reason?: string;
    comparison_reusable_tokens?: number;
    cache_missed_tokens?: number;
  };
};

function sessionCacheKey(value: unknown): string | undefined {
  return typeof value === 'string' && SESSION_CACHE_KEY.test(value) ? value : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z_]{1,48}$/.test(value) ? value : undefined;
}

type Fingerprint = ReturnType<typeof fingerprintChatGptPlanPrefix>;
type PrefixComparison = ReturnType<typeof compareChatGptPlanPrefixes>;

type CacheBaseline = {
  ordinal: number;
  observedAt: number;
  fingerprint: Fingerprint;
  responseId?: string;
};

type PreparedRequest = {
  key?: string;
  ordinal: number;
  startedAt: number;
  fingerprint?: Fingerprint;
  previous?: CacheBaseline;
  baselineState: 'cold' | 'recent' | 'expired' | 'no-session-key';
  newerRequestWasSent?: boolean;
  comparisonResponseId?: string;
  effort?: string;
  toolMode: 'append-only' | 'standard';
};
type CacheRequest = { prepared?: PreparedRequest; recorded?: boolean };
type RequestStatus = 'completed' | 'failed' | 'incomplete' | 'transport-error';

function localFinding(cachedTokens: number | undefined, prefix: PrefixComparison | undefined) {
  if (cachedTokens === undefined) return 'unknown';
  if (cachedTokens > 0) return 'cache-read';
  if (prefix?.firstChangedSection === 'none') return 'stable-prefix-zero-read';
  if (prefix && prefix.firstChangedSection !== 'unknown') return 'prefix-changed';
  return 'unknown';
}

export class ChatGptPlanCacheDiagnostics {
  private readonly baselines = new Map<string, CacheBaseline>();
  private readonly lastStarted = new Map<string, number>();
  private readonly requests = new AsyncLocalStorage<CacheRequest>();
  private readonly digestKey = randomBytes(32);
  private readonly scopeTag = randomBytes(8).toString('hex');
  private ordinal = 0;

  constructor(private readonly model: string, private readonly compareWithOpenAi: boolean) {}

  async withRequest<T>(run: () => PromiseLike<T>): Promise<{ result: T; request: CacheRequest }> {
    const request: CacheRequest = {};
    try {
      const result = await this.requests.run(request, async () => run());
      return { result, request };
    } catch (error) {
      this.record({}, request, undefined, 'transport-error');
      throw error;
    }
  }

  prepare(body: Record<string, unknown>, appendOnlyTools = false): string | undefined {
    const key = sessionCacheKey(body['prompt_cache_key']);
    const request = this.requests.getStore();
    if (!request) return undefined;
    const effort = diagnosticCode((body.reasoning as { effort?: unknown } | undefined)?.effort);
    const common = {
      ordinal: ++this.ordinal, startedAt: Date.now(), effort,
      toolMode: appendOnlyTools ? 'append-only' as const : 'standard' as const,
    };
    if (!key) {
      request.prepared = { ...common, baselineState: 'no-session-key' };
      return undefined;
    }

    const baseline = this.baselines.get(key);
    const previous = baseline && common.startedAt - baseline.observedAt <= MAX_BASELINE_AGE_MS ? baseline : undefined;
    const comparisonResponseId = this.compareWithOpenAi ? previous?.responseId : undefined;
    request.prepared = {
      ...common, key, previous, comparisonResponseId,
      fingerprint: fingerprintChatGptPlanPrefix(body, this.digestKey),
      baselineState: previous ? 'recent' : baseline ? 'expired' : 'cold',
      newerRequestWasSent: previous ? (this.lastStarted.get(key) ?? 0) > previous.ordinal : undefined,
    };
    this.lastStarted.delete(key);
    this.lastStarted.set(key, common.ordinal);
    if (this.lastStarted.size > MAX_SESSIONS) this.lastStarted.delete(this.lastStarted.keys().next().value!);
    return comparisonResponseId;
  }

  record(
    response: ChatGptPlanCompletedResponse, request?: CacheRequest, upstreamRequestId?: string,
    status: RequestStatus = 'completed',
  ): void {
    if (!request?.prepared || request.recorded) return;
    const prepared = request.prepared;
    request.recorded = true;
    const { key, ordinal, startedAt, previous, fingerprint } = prepared;
    const finishedAt = Date.now();
    const prefix = previous && fingerprint ? compareChatGptPlanPrefixes(previous.fingerprint, fingerprint) : undefined;
    const inputTokens = tokenCount(response.usage?.input_tokens);
    const cachedTokens = tokenCount(response.usage?.input_tokens_details?.cached_tokens);
    const cacheWriteTokens = tokenCount(response.usage?.input_tokens_details?.cache_write_tokens);
    const details = response.prompt_cache_diagnostics;
    console.error(`[leverframe openai cache] ${JSON.stringify({
      model: this.model,
      status,
      effort: prepared.effort,
      toolMode: prepared.toolMode,
      sessionTag: key && createHmac('sha256', sessionTagKey).update(key).digest('hex').slice(0, 16),
      scopeTag: this.scopeTag,
      requestSequence: ordinal,
      startedAtMs: startedAt,
      elapsedMs: Math.max(0, finishedAt - startedAt),
      comparisonMode: this.compareWithOpenAi ? 'openai' : 'local-only',
      comparisonSent: Boolean(prepared.comparisonResponseId),
      baselineState: prepared.baselineState,
      baselineAgeMs: previous ? Math.max(0, startedAt - previous.observedAt) : undefined,
      newerRequestWasSent: prepared.newerRequestWasSent,
      upstreamRequestId: this.compareWithOpenAi && upstreamRequestId && REQUEST_ID.test(upstreamRequestId)
        ? upstreamRequestId : undefined,
      inputTokens, cachedTokens, cacheWriteTokens,
      outputTokens: tokenCount(response.usage?.output_tokens),
      outcome: diagnosticCode(details?.type),
      reason: diagnosticCode(details?.reason),
      reusableTokens: tokenCount(details?.comparison_reusable_tokens),
      missedTokens: tokenCount(details?.cache_missed_tokens),
      localFinding: localFinding(cachedTokens, prefix),
      prefix,
    })}`);
    if (status !== 'completed') return;
    if (prefix && this.compareWithOpenAi) console.error(`[leverframe openai prefix] ${JSON.stringify(prefix)}`);

    if (!key || !fingerprint) return;
    const baseline = this.baselines.get(key);
    if (baseline && ordinal <= baseline.ordinal) return;
    const responseId = this.compareWithOpenAi && typeof response.id === 'string' && RESPONSE_ID.test(response.id)
      ? response.id : undefined;
    this.baselines.delete(key);
    this.baselines.set(key, { ordinal, observedAt: finishedAt, fingerprint, responseId });
    if (this.baselines.size > MAX_SESSIONS) this.baselines.delete(this.baselines.keys().next().value!);
  }
}

export function createChatGptPlanCacheDiagnostics(model: string, compareWithOpenAi: boolean): ChatGptPlanCacheDiagnostics {
  return new ChatGptPlanCacheDiagnostics(model, compareWithOpenAi);
}
