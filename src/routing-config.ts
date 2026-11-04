import type { ModelRef, RoutingConfig } from './model-routing.js';

type ObjectValue = Record<string, unknown>;

function invalid(path: string): never {
  throw new Error(`Invalid routing.${path}`);
}

function object(value: unknown, path: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  return value as ObjectValue;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()
    || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid(path);
  return value;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) string(value, path);
}

function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'boolean') invalid(path);
}

function number(value: unknown, path: string, minimum: number, maximum = Infinity, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
    || (integer && !Number.isSafeInteger(value))) invalid(path);
}

function reference(value: unknown, path: string, withEffort = false): ModelRef {
  const item = object(value, path);
  string(item.providerId, `${path}.providerId`);
  string(item.modelId, `${path}.modelId`);
  if (withEffort) optionalString(item.effort, `${path}.effort`);
  return item as unknown as ModelRef;
}

function referenceKey(ref: ModelRef): string {
  return JSON.stringify([ref.providerId, ref.modelId]);
}

function references(value: unknown, path: string, initial: ModelRef[] = [], withEffort = false): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalid(path);
  const seen = new Set(initial.map(referenceKey));
  value.forEach((entry, index) => {
    const key = referenceKey(reference(entry, `${path}.${index}`, withEffort));
    if (seen.has(key)) invalid(`${path}.${index}`);
    seen.add(key);
  });
}

function category(value: unknown, path: string, key: string): void {
  const item = object(value, path);
  const target = item.target === undefined ? undefined : reference(item.target, `${path}.target`);
  optionalString(item.effort, `${path}.effort`);
  optionalString(item.instructions, `${path}.instructions`);
  if (item.requirements !== undefined) {
    const requirements = object(item.requirements, `${path}.requirements`);
    if (Object.keys(requirements).some(name => !['capabilities', 'contextTokens'].includes(name))) invalid(`${path}.requirements`);
    if (requirements.capabilities !== undefined) {
      if (!Array.isArray(requirements.capabilities) || requirements.capabilities.some(value =>
        !['tools', 'images', 'reasoning', 'promptCache', 'websocket'].includes(value))
        || new Set(requirements.capabilities).size !== requirements.capabilities.length) invalid(`${path}.requirements.capabilities`);
    }
    if (requirements.contextTokens !== undefined) number(requirements.contextTokens, `${path}.requirements.contextTokens`, 1, Number.MAX_SAFE_INTEGER, true);
  }
  references(item.servingAlternatives, `${path}.servingAlternatives`, target ? [target] : []);
  references(item.fallbacks, `${path}.fallbacks`, target ? [target] : [], true);
  if (item.alternatingTargets !== undefined) {
    if (key !== 'deep_research' || target || !Array.isArray(item.alternatingTargets) || item.alternatingTargets.length !== 2) {
      invalid(`${path}.alternatingTargets`);
    }
    references(item.alternatingTargets, `${path}.alternatingTargets`, [], true);
    item.alternatingTargets.forEach((entry, index) => {
      string(object(entry, `${path}.alternatingTargets.${index}`).effort, `${path}.alternatingTargets.${index}.effort`);
    });
  }
}

function evidence(value: unknown, path: string): void {
  const item = object(value, path);
  for (const key of ['category', 'candidateSetVersion', 'signatureVersion', 'sourceEvaluationId', 'measuredAt', 'expiresAt']) {
    string(item[key], `${path}.${key}`);
  }
  optionalString(item.effort, `${path}.effort`);
  number(item.sampleSize, `${path}.sampleSize`, 1, Infinity, true);
  const measured = Date.parse(item.measuredAt as string);
  const expires = Date.parse(item.expiresAt as string);
  if (!Number.isFinite(measured)) invalid(`${path}.measuredAt`);
  if (!Number.isFinite(expires) || expires <= measured) invalid(`${path}.expiresAt`);
  const tokens = object(item.avoidedTokens, `${path}.avoidedTokens`);
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (tokens[key] !== undefined) number(tokens[key], `${path}.avoidedTokens.${key}`, 0);
  }
}

function selector(value: unknown): void {
  const item = object(value, 'selector');
  optionalBoolean(item.enabled, 'selector.enabled');
  const target = item.target === undefined ? undefined : reference(item.target, 'selector.target');
  references(item.fallbacks, 'selector.fallbacks', target ? [target] : []);
  if (item.maxExtraCallsPerTask !== undefined) number(item.maxExtraCallsPerTask, 'selector.maxExtraCallsPerTask', 0, Number.MAX_SAFE_INTEGER, true);
  if (item.timeoutMs !== undefined) number(item.timeoutMs, 'selector.timeoutMs', 1, 300000, true);
  if (item.maxOutputTokens !== undefined) number(item.maxOutputTokens, 'selector.maxOutputTokens', 1, 8192, true);
  if (item.evaluationEvidence !== undefined) {
    if (!Array.isArray(item.evaluationEvidence)) invalid('selector.evaluationEvidence');
    item.evaluationEvidence.forEach((entry, index) => evidence(entry, `selector.evaluationEvidence.${index}`));
  }
}

export function parseRoutingConfig(value: unknown): RoutingConfig | undefined {
  if (value === undefined) return undefined;
  const item = object(value, 'config');
  optionalBoolean(item.enabled, 'enabled');
  optionalBoolean(item.recoveryEnabled, 'recoveryEnabled');
  optionalString(item.visibleModelId, 'visibleModelId');
  optionalString(item.visibleModelLabel, 'visibleModelLabel');
  if (item.policy !== undefined && item.policy !== 'execution') invalid('policy');
  references(item.pool, 'pool');
  const floor = item.cheapFloor === undefined ? undefined : reference(item.cheapFloor, 'cheapFloor');
  if (item.enabled === true && item.cheapFallback === undefined) invalid('cheapFallback');
  const fallback = item.cheapFallback === undefined ? undefined : reference(item.cheapFallback, 'cheapFallback');
  references(item.routerFallbacks, 'routerFallbacks', [floor, fallback].filter((ref): ref is ModelRef => ref !== undefined));
  optionalString(item.defaultCategory, 'defaultCategory');
  const categories = item.categories === undefined ? undefined : object(item.categories, 'categories');
  if (categories) {
    for (const [key, entry] of Object.entries(categories)) {
      string(key, 'categories');
      category(entry, `categories.${key}`, key);
    }
  }
  if (item.defaultCategory !== undefined && (!categories || !Object.hasOwn(categories, item.defaultCategory as string))) invalid('defaultCategory');
  if (item.agentCategories !== undefined) {
    for (const [key, target] of Object.entries(object(item.agentCategories, 'agentCategories'))) {
      string(key, 'agentCategories');
      string(target, `agentCategories.${key}`);
      if (!categories || !Object.hasOwn(categories, target as string)) invalid(`agentCategories.${key}`);
    }
  }
  if (item.subscriptionPreference !== undefined && !['auto', 'subscription-first', 'api-first', 'balanced'].includes(item.subscriptionPreference as string)) invalid('subscriptionPreference');
  if (item.selector !== undefined) selector(item.selector);
  if (item.costTierTolerance !== undefined) number(item.costTierTolerance, 'costTierTolerance', 0);
  return item as unknown as RoutingConfig;
}
