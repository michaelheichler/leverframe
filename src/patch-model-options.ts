import { ANTHROPIC_API_PROVIDER_ID } from './provider-templates.js';
import { applyModelPickerOptions } from './patch-model-picker-options.js';
import { applySelectBadge } from './patch-select-badge.js';
import type { PatchScriptEffort, PatchScriptModelConfig, PatchSiteResult } from './patch-transforms.js';

const ANTHROPIC_API_IDENTITY_PREFIX = `leverframe:${ANTHROPIC_API_PROVIDER_ID}:`;
const NATIVE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const BASE_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export function projectNativeEffort(effort: PatchScriptEffort | undefined): PatchScriptEffort | undefined {
  if (!effort || !Array.isArray(effort.levels) || typeof effort.defaultLevel !== 'string') return undefined;
  const declared = new Set(effort.levels);
  if (!BASE_EFFORT_LEVELS.every(level => declared.has(level))) return undefined;
  const levels = NATIVE_EFFORT_LEVELS.filter(level => declared.has(level));
  if (!levels.some(level => level === effort.defaultLevel)) return undefined;
  return { levels, defaultLevel: 'high' };
}

export function shortDisplayName(display: string | undefined): string | undefined {
  const trimmed = display?.trim();
  if (!trimmed?.endsWith(')')) return trimmed;
  let depth = 0;
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] === ')') depth += 1;
    else if (trimmed[index] === '(' && --depth === 0) return trimmed.slice(0, index).trim() || trimmed;
  }
  return trimmed;
}

function comparableName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function aliasLabel(alias: string, modelName: string | undefined): string {
  const label = alias.charAt(0).toUpperCase() + alias.slice(1);
  // Because an alias can outlive its model version, the name alone can mislead.
  return modelName && !comparableName(modelName).includes(comparableName(alias))
    ? `${label} (${modelName})`
    : label;
}

export function applyConfiguredModelPicker(source: string, options: {
  identities: string[];
  aliases: Record<string, string>;
  displays: Record<string, string>;
  models: PatchScriptModelConfig;
  routingModelId?: string;
}): { content: string; results: PatchSiteResult[] } {
  const identities = options.routingModelId ? [options.routingModelId] : options.identities;
  const pickerOptions = [...new Set(identities)].map(identity => {
    const canonicalId = options.aliases[identity] ?? identity;
    const display = options.displays[identity] ?? options.displays[canonicalId];
    const isAlias = options.aliases[identity] !== undefined;
    const entry = options.models[canonicalId.replace(/(?:\[(?:default|maximum|1m)\])+$/i, '')];
    const accountTag = entry?.accountTag;
    const capabilities = entry?.capabilities ? ` ${entry.capabilities}` : '';
    const badge = accountTag ? { badge: accountTag, badgeColor: '#ff9f43' }
      : canonicalId.startsWith(ANTHROPIC_API_IDENTITY_PREFIX) ? { badge: 'API' } : {};
    const description = options.displays[identity] || 'Custom model (' + canonicalId + ')';
    return {
      ...badge,
      value: identity,
      label: isAlias ? aliasLabel(identity, shortDisplayName(display)) : display ?? canonicalId,
      description: (isAlias ? description : display ? 'Model ID: ' + canonicalId : description) + capabilities,
    };
  });
  const picker = applyModelPickerOptions(source, pickerOptions, !!options.routingModelId);
  const results = [picker.result];
  if (!pickerOptions.some(option => 'badge' in option)) return { content: picker.content, results };
  const badged = applySelectBadge(picker.content);
  results.push(badged.result);
  return { content: badged.content, results };
}
