export const ONE_M_CONTEXT_SUFFIX = '[1m]';
export const ONE_M_CONTEXT_WINDOW = 1_000_000;
export const CONTEXT_MAXIMUM_SUFFIX = '[maximum]';
export const CONTEXT_DEFAULT_SUFFIX = '[default]';

export type ContextMode = 'default' | 'maximum';

export interface ParsedContextModeModelId {
  modelId: string;
  mode?: ContextMode;
}

export function stripOneMContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, '');
}

export function hasOneMContextSuffix(modelId: string): boolean {
  return /\[1m\]$/i.test(modelId);
}

export function parseContextModeModelId(modelId: string): ParsedContextModeModelId {
  if (new RegExp(`${CONTEXT_MAXIMUM_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(modelId)) {
    return { modelId: modelId.slice(0, -CONTEXT_MAXIMUM_SUFFIX.length), mode: 'maximum' };
  }
  if (new RegExp(`${CONTEXT_DEFAULT_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(modelId)) {
    return { modelId: modelId.slice(0, -CONTEXT_DEFAULT_SUFFIX.length), mode: 'default' };
  }
  return { modelId };
}

export function stripContextModeSuffix(modelId: string): string {
  return parseContextModeModelId(modelId).modelId;
}

export function contextModeModelId(modelId: string, mode: ContextMode): string {
  const bare = stripOneMContextSuffix(stripContextModeSuffix(modelId));
  return mode === 'maximum' ? `${bare}${CONTEXT_MAXIMUM_SUFFIX}` : bare;
}

export function claudeCodeClientModelId(modelId: string, contextWindow?: number): string {
  const bare = stripOneMContextSuffix(stripContextModeSuffix(modelId));
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow >= ONE_M_CONTEXT_WINDOW) {
    return `${bare}${ONE_M_CONTEXT_SUFFIX}`;
  }
  return bare;
}

export function routeLookupIds(id: string): string[] {
  const parsed = parseContextModeModelId(id);
  const bare = stripOneMContextSuffix(parsed.modelId);
  const googleBare = bare.startsWith('models/') ? bare.slice('models/'.length) : bare;
  return [...new Set([
    id,
    bare,
    `${bare}${CONTEXT_DEFAULT_SUFFIX}`,
    `${bare}${CONTEXT_MAXIMUM_SUFFIX}`,
    `${bare}${ONE_M_CONTEXT_SUFFIX}`,
    googleBare,
    `${googleBare}${CONTEXT_DEFAULT_SUFFIX}`,
    `${googleBare}${CONTEXT_MAXIMUM_SUFFIX}`,
    `${googleBare}${ONE_M_CONTEXT_SUFFIX}`,
    `models/${googleBare}`,
    `models/${bare}`,
  ])];
}
