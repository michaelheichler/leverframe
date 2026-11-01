import type { CapacityObservation } from './account-pool.js';

export function anthropicCapacity(headers: Headers, accountId: string, now: number): CapacityObservation[] {
  const windows = ['requests', 'input-tokens', 'output-tokens'].flatMap(unit => {
    const raw = headers.get(`anthropic-ratelimit-${unit}-remaining`);
    if (raw === null || !/^\d+$/.test(raw)) return [];
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return [];
    const reset = headers.get(`anthropic-ratelimit-${unit}-reset`);
    const parsedReset = reset === null ? NaN : Date.parse(reset);
    return [{ unit, value, resetAt: Number.isFinite(parsedReset) ? parsedReset : undefined }];
  });
  return windows.map(window => ({
    accountId, scope: { kind: 'pool' }, source: 'anthropic:headers', observedAt: now,
    dimension: `anthropic:${window.unit}`,
    status: window.value === 0 ? 'rate_limited' : 'healthy',
    remaining: { value: window.value, unit: `anthropic:${window.unit}` },
    ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
  }));
}

export function codexCapacity(headers: Headers, accountId: string, now: number): CapacityObservation[] {
  const prefixes = new Set<string>();
  for (const name of headers.keys()) {
    const match = /^(x-[a-z0-9-]{1,100})-(?:primary|secondary)-used-percent$/.exec(name);
    if (match) prefixes.add(match[1]);
  }
  return [...prefixes].flatMap(prefix => ['primary', 'secondary'].flatMap(window => {
    const used = headers.get(`${prefix}-${window}-used-percent`);
    const minutes = headers.get(`${prefix}-${window}-window-minutes`);
    if (!used || !/^\d+(?:\.\d+)?$/.test(used) || !minutes || !/^\d+$/.test(minutes)) return [];
    const percent = Number(used);
    const duration = Number(minutes);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100 || !Number.isSafeInteger(duration) || duration <= 0) return [];
    const rawReset = headers.get(`${prefix}-${window}-reset-at`);
    const reset = rawReset && /^\d+$/.test(rawReset) ? Number(rawReset) * 1000 : NaN;
    const dimension = `codex:${prefix.slice(2).replaceAll('-', '_')}:${window}:${duration}`;
    return [{
      accountId, scope: { kind: 'pool' as const }, source: 'codex:headers', observedAt: now,
      dimension, status: percent === 100 ? 'rate_limited' as const : 'healthy' as const,
      remaining: { value: 100 - percent, unit: dimension },
      ...(Number.isSafeInteger(reset) && reset <= 8.64e15 ? { resetAt: reset } : {}),
    }];
  }));
}

export function codexEventCapacity(payload: string, accountId: string, now: number): CapacityObservation[] {
  let event: unknown;
  try { event = JSON.parse(payload); } catch { return []; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
  const value = event as Record<string, unknown>;
  if (value.type !== 'codex.rate_limits' || !value.rate_limits || typeof value.rate_limits !== 'object'
    || Array.isArray(value.rate_limits)) return [];
  const rawLimit = value.metered_limit_name ?? value.limit_name ?? 'codex';
  if (typeof rawLimit !== 'string' || !rawLimit.trim() || rawLimit.length > 100
    || Array.from(rawLimit).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return [];
  const limit = rawLimit.trim().toLowerCase().replaceAll('-', '_');
  const details = value.rate_limits as Record<string, unknown>;
  return ['primary', 'secondary'].flatMap(window => {
    const raw = details[window];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const used = item.used_percent;
    const duration = item.window_minutes;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100
      || typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0) return [];
    const reset = typeof item.reset_at === 'number' ? item.reset_at * 1000 : NaN;
    const dimension = `codex:${limit}:${window}:${duration}`;
    return [{
      accountId, scope: { kind: 'pool' as const }, source: 'codex:event', observedAt: now, dimension,
      status: used === 100 ? 'rate_limited' as const : 'healthy' as const,
      remaining: { value: 100 - used, unit: dimension },
      ...(Number.isSafeInteger(reset) && reset >= 0 && reset <= 8.64e15 ? { resetAt: reset } : {}),
    }];
  });
}

export function observeCodexEvents(response: Response, observe: (payload: string) => Promise<void>): Response {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const decoder = new TextDecoder();
  let pending = '';
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (pending.length > 262_144) pending = '';
      for (const line of lines) {
        if (line.startsWith('data:')) await observe(line.slice(5).trim());
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
